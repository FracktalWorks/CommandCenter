/**
 * This file can be edited to adjust the ESBuild build process.
 * To reset, delete this file and rerun theia build again.
 */
import { browserOptions, watch } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';

import esbuild from 'esbuild';

// `@vscode/windows-ca-certs` is an optional native module (Windows system cert
// store) pulled in by `@vscode/proxy-agent`. Its `crypt32.node` binary does not
// build without the MSVC Spectre-mitigated libraries, which breaks bundling.
// Mark it external so the shell can build/boot; proxy-agent degrades gracefully.
const externalWindowsCaCerts = {
    name: 'external-windows-ca-certs',
    setup(build) {
        build.onResolve({ filter: /^@vscode\/windows-ca-certs$/ }, () => ({
            path: '@vscode/windows-ca-certs',
            external: true,
        }));
    },
};
nodeOptions.plugins = [externalWindowsCaCerts, ...(nodeOptions.plugins ?? [])];

const browserContext = await esbuild.context(browserOptions);
const nodeContext = await esbuild.context(nodeOptions);


if (watch) {
    await Promise.all([
        browserContext.watch(),
        nodeContext.watch(),
    ]);
} else {
    try {
        await browserContext.rebuild();
        await browserContext.dispose();
        await nodeContext.rebuild();
        await nodeContext.dispose();
    } catch {
        process.exit(1);
    }
}
