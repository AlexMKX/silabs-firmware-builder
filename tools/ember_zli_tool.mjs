#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function printUsageAndExit(exitCode = 1) {
    const msg = `Usage:
  node tools/ember_zli_tool.mjs dump-stack-config [--port tcp://host:port] [--out file.json]
  node tools/ember_zli_tool.mjs flash-gbl --gbl file.gbl [--port tcp://host:port]

Notes:
  - Uses the locally installed ember-zli package (no interactive TUI).
  - If --port is omitted, uses ember-zli cached port config (~/ember-zli/conf_port.json).
`;
    console.error(msg);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) {
            continue;
        }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

function findPackageRootFromEntry(entryPath) {
    let dir = path.dirname(entryPath);

    for (let i = 0; i < 10; i++) {
        const pkgPath = path.join(dir, "package.json");
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
                if (pkg?.name === "ember-zli") {
                    return dir;
                }
            } catch {
            }
        }

        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }

    throw new Error("Failed to locate ember-zli package root from installed binary.");
}

function resolveEmberZliRoot() {
    const resolved = execFileSync("bash", ["-lc", "readlink -f \"$(command -v ember-zli)\""], { encoding: "utf8" }).trim();
    if (!resolved) {
        throw new Error("ember-zli not found in PATH");
    }
    return findPackageRootFromEntry(resolved);
}

async function importFromEmberZli(emberRoot, relativePath) {
    const abs = path.join(emberRoot, relativePath);
    return await import(pathToFileURL(abs).href);
}

function loadPortConf(confPortPath, overridePort) {
    let conf;
    if (fs.existsSync(confPortPath)) {
        conf = JSON.parse(fs.readFileSync(confPortPath, "utf8"));
    }
    if (!conf && !overridePort) {
        throw new Error(`No cached port config found at ${confPortPath} and --port not provided.`);
    }
    conf = conf ?? {};
    if (overridePort) {
        conf.path = overridePort;
    }
    if (!conf.path) {
        throw new Error("Port config does not include a valid 'path'.");
    }
    return conf;
}

async function dumpStackConfig({ emberRoot, portConf, outFile }) {
    const { emberStart, emberStop, getLibraryStatus } = await importFromEmberZli(emberRoot, "dist/utils/ember.js");

    const { EzspConfigId, EzspDecisionBitmask, EzspDecisionId, EzspMfgTokenId, EzspPolicyId } = await importFromEmberZli(
        emberRoot,
        "node_modules/zigbee-herdsman/dist/adapter/ember/ezsp/enums.js",
    );

    const { EmberLibraryId, SLStatus } = await importFromEmberZli(
        emberRoot,
        "node_modules/zigbee-herdsman/dist/adapter/ember/enums.js",
    );

    let ezsp;
    try {
        ezsp = await emberStart(portConf);

        const stackConfig = {};

        for (const key of Object.keys(EzspConfigId)) {
            const configId = EzspConfigId[key];
            if (typeof configId !== "number") {
                continue;
            }
            const [status, value] = await ezsp.ezspGetConfigurationValue(configId);
            stackConfig[`CONFIG.${key}`] = status === SLStatus.OK ? value : `STATUS:${SLStatus[status]}`;
        }

        {
            const [status, value] = await ezsp.ezspGetPolicy(EzspPolicyId.TRUST_CENTER_POLICY);
            const tcDecisions = [];
            for (const k of Object.keys(EzspDecisionBitmask)) {
                const bitmask = EzspDecisionBitmask[k];
                if (typeof bitmask !== "number") {
                    continue;
                }
                if ((value & bitmask) !== 0) {
                    tcDecisions.push(k);
                }
            }
            stackConfig["POLICY.TRUST_CENTER_POLICY"] = status === SLStatus.OK ? tcDecisions : `STATUS:${SLStatus[status]}`;
        }

        for (const key of Object.keys(EzspPolicyId)) {
            const policyId = EzspPolicyId[key];
            if (typeof policyId !== "number" || policyId === EzspPolicyId.TRUST_CENTER_POLICY) {
                continue;
            }
            const [status, value] = await ezsp.ezspGetPolicy(policyId);
            stackConfig[`POLICY.${key}`] = status === SLStatus.OK ? EzspDecisionId[value] : `STATUS:${SLStatus[status]}`;
        }

        {
            const status = await ezsp.ezspGetLibraryStatus(EmberLibraryId.ZIGBEE_PRO);
            stackConfig["LIBRARY.ZIGBEE_PRO"] = getLibraryStatus(EmberLibraryId.ZIGBEE_PRO, status);
        }

        for (let i = EmberLibraryId.FIRST + 1; i < EmberLibraryId.NUMBER_OF_LIBRARIES; i++) {
            const status = await ezsp.ezspGetLibraryStatus(i);
            stackConfig[`LIBRARY.${EmberLibraryId[i]}`] = getLibraryStatus(i, status);
        }

        for (const key of Object.keys(EzspMfgTokenId)) {
            const tokenId = EzspMfgTokenId[key];
            if (typeof tokenId !== "number") {
                continue;
            }
            const [, tokenData] = await ezsp.ezspGetMfgToken(tokenId);
            stackConfig[`MFG_TOKEN.${key}`] = tokenData;
        }

        const json = JSON.stringify(stackConfig, null, 2);

        if (outFile) {
            fs.writeFileSync(outFile, json, "utf8");
            console.log(outFile);
        } else {
            console.log(json);
        }
    } finally {
        if (ezsp) {
            await emberStop(ezsp);
        }
    }
}

async function flashGbl({ emberRoot, portConf, gblPath }) {
    const { GeckoBootloader, BootloaderState } = await importFromEmberZli(emberRoot, "dist/utils/bootloader.js");

    const firmware = fs.readFileSync(gblPath);

    const gecko = new GeckoBootloader(portConf, undefined);

    gecko.on("failed", () => {
        console.error("Bootloader operation failed.");
        process.exit(1);
    });

    gecko.on("uploadStart", () => {
        console.log("Upload started");
    });

    gecko.on("uploadProgress", (pc) => {
        process.stdout.write(`\rUpload: ${pc}%`);
    });

    gecko.on("uploadStop", () => {
        process.stdout.write("\nUpload stopped\n");
    });

    await gecko.knock(false);

    if (gecko.state !== BootloaderState.IDLE) {
        await gecko.ezspLaunch();
        await new Promise((r) => setTimeout(r, 250));
        await gecko.knock(true);
    }

    if (gecko.state !== BootloaderState.IDLE) {
        throw new Error("Failed to enter bootloader (no 'BL >' prompt).");
    }

    await gecko.menuUploadGBL(firmware);
    await gecko.menuRun();

    await gecko.transport.close(false);
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    if (!cmd) {
        printUsageAndExit(1);
    }

    const args = parseArgs(rest);
    const emberRoot = resolveEmberZliRoot();
    const emberIndex = await importFromEmberZli(emberRoot, "dist/index.js");

    const portConf = loadPortConf(emberIndex.CONF_PORT_PATH, args.port);

    if (cmd === "dump-stack-config") {
        await dumpStackConfig({ emberRoot, portConf, outFile: args.out });
        return;
    }

    if (cmd === "flash-gbl") {
        if (!args.gbl || typeof args.gbl !== "string") {
            throw new Error("--gbl <file.gbl> is required");
        }
        await flashGbl({ emberRoot, portConf, gblPath: args.gbl });
        return;
    }

    printUsageAndExit(1);
}

await main();
