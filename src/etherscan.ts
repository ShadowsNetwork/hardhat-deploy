/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import axios from 'axios';
import qs from 'qs';
import path from 'path';
import {defaultAbiCoder, ParamType} from '@ethersproject/abi';
import {HardhatRuntimeEnvironment} from 'hardhat/types';
import chalk from 'chalk';
import matchAll from 'match-all';

function log(...args: any[]) {
  console.log(...args);
}

function logError(...args: any[]) {
  console.log(chalk.red(...args));
}

function logInfo(...args: any[]) {
  console.log(chalk.yellow(...args));
}

function logSuccess(...args: any[]) {
  console.log(chalk.green(...args));
}

function extractOneLicenseFromSourceFile(source: string): string | undefined {
  const licenses = extractLicenseFromSources(source);
  if (licenses.length === 0) {
    return undefined;
  }
  return licenses[0]; // TODO error out on multiple SPDX ?
}

function extractLicenseFromSources(metadata: string): string[] {
  const regex = /\/\/\s*\t*SPDX-License-Identifier:\s*\t*(.*?)[\s\\]/g;
  const matches = matchAll(metadata, regex).toArray();
  const licensesFound: {[license: string]: boolean} = {};
  const licenses = [];
  if (matches) {
    for (const match of matches) {
      if (!licensesFound[match]) {
        licensesFound[match] = true;
        licenses.push(match);
      }
    }
  }
  return licenses;
}

function getLicenseType(license: string): undefined | number {
  const licenseType = (() => {
    if (license === 'None') {
      return 1;
    }
    if (license === 'UNLICENSED') {
      return 2;
    }
    if (license === 'MIT') {
      return 3;
    }
    if (license === 'GPL-2.0') {
      return 4;
    }
    if (license === 'GPL-3.0') {
      return 5;
    }
    if (license === 'LGPL-2.1') {
      return 6;
    }
    if (license === 'LGPL-3.0') {
      return 7;
    }
    if (license === 'BSD-2-Clause') {
      return 8;
    }
    if (license === 'BSD-3-Clause') {
      return 9;
    }
    if (license === 'MPL-2.0') {
      return 10;
    }
    if (license === 'OSL-3.0') {
      return 11;
    }
    if (license === 'Apache-2.0') {
      return 12;
    }
    if (license === 'AGPL-3.0') {
      return 13;
    }
  })();
  return licenseType;
}

export async function submitSources(
  hre: HardhatRuntimeEnvironment,
  solcInputsPath: string,
  config?: {
    etherscanApiKey?: string;
    license?: string;
    fallbackOnSolcInput?: boolean;
    forceLicense?: boolean;
  }
): Promise<void> {
  config = config || {};
  const fallbackOnSolcInput = config.fallbackOnSolcInput;
  const licenseOption = config.license;
  const forceLicense = config.forceLicense;
  const etherscanApiKey = config.etherscanApiKey;
  const chainId = await hre.getChainId();
  const all = await hre.deployments.all();
  let host: string;
  switch (chainId) {
    case '1':
      host = 'http://api.etherscan.io';
      break;
    case '3':
      host = 'http://api-ropsten.etherscan.io';
      break;
    case '4':
      host = 'http://api-rinkeby.etherscan.io';
      break;
    case '5':
      host = 'http://api-goerli.etherscan.io';
      break;
    case '42':
      host = 'http://api-kovan.etherscan.io';
      break;
    case '97':
      host = 'https://api-testnet.bscscan.com';
      break;
    case '56':
      host = 'https://api.bscscan.com';
      break;
    case '128':
      host = 'https://api.hecoinfo.com';
      break;
    case '256':
      host = 'https://api-testnet.hecoinfo.com';
      break;
    default:
      return logError(`Network with chainId: ${chainId} not supported`);
  }

  async function submit(name: string, useSolcInput?: boolean) {
    const deployment = all[name];
    const {address, metadata: metadataString} = deployment;
    const abiResponse = await axios.get(
      `${host}/api?module=contract&action=getabi&address=${address}&apikey=${etherscanApiKey}`
    );
    const {data: abiData} = abiResponse;
    let contractABI;
    if (abiData.status !== '0') {
      try {
        contractABI = JSON.parse(abiData.result);
      } catch (e) {
        logError(e);
        return;
      }
    }
    if (contractABI && contractABI !== '') {
      log(`already verified: ${name} (${address}), skipping.`);
      return;
    }

    if (!metadataString) {
      logError(
        `Contract ${name} was deployed without saving metadata. Cannot submit to etherscan, skipping.`
      );
      return;
    }
    const metadata = JSON.parse(metadataString);
    const compilationTarget = metadata.settings?.compilationTarget;

    let contractFilepath;
    let contractName;
    if (compilationTarget) {
      contractFilepath = Object.keys(compilationTarget)[0];
      contractName = compilationTarget[contractFilepath];
    }

    if (!contractFilepath || !contractName) {
      return logError(
        `Failed to extract contract fully qualified name from metadata.settings.compilationTarget for ${name}. Skipping.`
      );
    }

    const contractNamePath = `${contractFilepath}:${contractName}`;

    const contractSourceFile = metadata.sources[contractFilepath].content;
    const sourceLicenseType = extractOneLicenseFromSourceFile(
      contractSourceFile
    );

    let license = licenseOption;
    if (!sourceLicenseType) {
      if (!license) {
        return logError(
          `no license speccified in the source code for ${name} (${contractNamePath}), Please use option --license <SPDX>`
        );
      }
    } else {
      if (license && license !== sourceLicenseType) {
        if (!forceLicense) {
          return logError(
            `mismatch for --license option (${licenseOption}) and the one specified in the source code for ${name}.\nLicenses found in source : ${sourceLicenseType}\nYou can use option --force-license to force option --license`
          );
        }
      } else {
        license = sourceLicenseType;
        if (!getLicenseType(license)) {
          return logError(
            `license :"${license}" found in source code for ${name} (${contractNamePath}) but this license is not supported by etherscan, list of supported license can be found here : https://etherscan.io/contract-license-types . This tool expect the SPDX id, except for "None" and "UNLICENSED"`
          );
        }
      }
    }

    const licenseType = getLicenseType(license);

    if (!licenseType) {
      return logError(
        `license :"${license}" not supported by etherscan, list of supported license can be found here : https://etherscan.io/contract-license-types . This tool expect the SPDX id, except for "None" and "UNLICENSED"`
      );
    }

    let solcInput: {
      language: string;
      settings: any;
      sources: Record<string, {content: string}>;
    };
    if (useSolcInput) {
      const solcInputHash = deployment.solcInputHash;
      let solcInputStringFromDeployment: string | undefined;
      try {
        solcInputStringFromDeployment = fs
          .readFileSync(path.join(solcInputsPath, solcInputHash + '.json'))
          .toString();
      } catch (e) {}
      if (!solcInputStringFromDeployment) {
        logError(
          `Contract ${name} was deployed without saving solcInput. Cannot submit to etherscan, skipping.`
        );
        return;
      }
      solcInput = JSON.parse(solcInputStringFromDeployment);
    } else {
      const settings = {...metadata.settings};
      delete settings.compilationTarget;
      solcInput = {
        language: metadata.language,
        settings,
        sources: {},
      };
      for (const sourcePath of Object.keys(metadata.sources)) {
        const source = metadata.sources[sourcePath];
        // only content as this fails otherwise
        solcInput.sources[sourcePath] = {
          content: source.content,
        };
      }
    }

    // Adding Libraries ....
    if (deployment.libraries) {
      const settings = solcInput.settings;
      settings.libraries = settings.libraries || {};
      for (const libraryName of Object.keys(deployment.libraries)) {
        if (!settings.libraries[contractNamePath]) {
          settings.libraries[contractNamePath] = {};
        }
        settings.libraries[contractNamePath][libraryName] =
          deployment.libraries[libraryName];
      }
    }
    const solcInputString = JSON.stringify(solcInput);

    logInfo(`verifying ${name} (${address}) ...`);

    let constructorArguements: string | undefined;
    if (deployment.args) {
      const constructor: {inputs: ParamType[]} = deployment.abi.find(
        (v) => v.type === 'constructor'
      );
      if (constructor) {
        constructorArguements = defaultAbiCoder
          .encode(constructor.inputs, deployment.args)
          .slice(2);
      }
    } else {
      logInfo(`no args found, assuming empty constructor...`);
    }

    const postData: {
      [fieldName: string]: string | number | void | undefined; // TODO type
    } = {
      apikey: etherscanApiKey,
      module: 'contract',
      action: 'verifysourcecode',
      contractaddress: address,
      sourceCode: solcInputString,
      codeformat: 'solidity-standard-json-input',
      contractname: contractNamePath,
      compilerversion: `v${metadata.compiler.version}`, // see http://etherscan.io/solcversions for list of support versions
      constructorArguements,
      licenseType,
    };

    const submissionResponse = await axios.request({
      url: `${host}/api`,
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      data: qs.stringify(postData),
    });
    const {data: submissionData} = submissionResponse;

    let guid: string;
    if (submissionData.status === '1') {
      guid = submissionData.result;
    } else {
      console.log(submissionData);
      logError(
        `contractsss ${name} failed to submit : "${submissionData.message}"`,
        submissionData
      );
      return;
    }
    if (!guid) {
      logError(`contract submission for ${name} failed to return a guid`);
      return;
    }

    async function checkStatus(): Promise<string | undefined> {
      // TODO while loop and delay :
      const statusResponse = await axios.get(
        `${host}/api?apikey=${etherscanApiKey}`,
        {
          params: {
            guid,
            module: 'contract',
            action: 'checkverifystatus',
          },
        }
      );
      const {data: statusData} = statusResponse;
      if (statusData.status === '1') {
        return 'success';
      }
      if (statusData.result === 'Pending in queue') {
        return undefined;
      }
      logError(
        `Failed to verify contract ${name}: ${statusData.message}, ${statusData.result}`
      );

      logError(
        JSON.stringify(
          {
            apikey: 'XXXXXX',
            module: 'contract',
            action: 'verifysourcecode',
            contractaddress: address,
            sourceCode: '...',
            codeformat: 'solidity-standard-json-input',
            contractname: contractNamePath,
            compilerversion: `v${metadata.compiler.version}`, // see http://etherscan.io/solcversions for list of support versions
            constructorArguements,
            licenseType,
          },
          null,
          '  '
        )
      );
      // logError(JSON.stringify(postData, null, "  "));
      // logInfo(postData.sourceCode);
      return 'failure';
    }

    logInfo('waiting for result...');
    let result;
    while (!result) {
      await new Promise((resolve) => setTimeout(resolve, 10 * 1000));
      result = await checkStatus();
    }

    if (result === 'success') {
      logSuccess(` => contract ${name} is now verified`);
    }

    if (result === 'failure') {
      if (!useSolcInput && fallbackOnSolcInput) {
        logInfo(
          'Falling back on solcInput. etherscan seems to sometime require full solc-input with all source files, even though this should not be needed. See https://github.com/ethereum/solidity/issues/9573'
        );
        await submit(name, true);
      } else {
        logInfo(
          'Etherscan sometime fails to verify when only metadata sources are given. See https://github.com/ethereum/solidity/issues/9573. You can add the option --solc-input to try with full solc-input sources. This will include all contract source in the etherscan result, even the one not relevant to the contract being verified'
        );
      }
    }
  }

  for (const name of Object.keys(all)) {
    await submit(name);
  }
}
