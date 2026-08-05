import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/test/**/*.test.ts'],
    },
    resolve: {
        alias: {
            '@addblocker/filter-parser': new URL('./packages/filter-parser/src/index.ts', import.meta.url).pathname,
            '@addblocker/dnr-compiler': new URL('./packages/dnr-compiler/src/index.ts', import.meta.url).pathname,
            '@addblocker/cosmetic-compiler': new URL('./packages/cosmetic-compiler/src/index.ts', import.meta.url).pathname,
            '@addblocker/cosmetic-runtime': new URL('./packages/cosmetic-runtime/src/apply.ts', import.meta.url).pathname,
            '@addblocker/scriptlet-compiler': new URL('./packages/scriptlet-compiler/src/index.ts', import.meta.url).pathname,
            '@addblocker/scriptlet-runtime/catalog': new URL('./packages/scriptlet-runtime/src/catalog.ts', import.meta.url).pathname,
            '@addblocker/scriptlet-runtime': new URL('./packages/scriptlet-runtime/src/run.ts', import.meta.url).pathname,
        },
    },
});
