import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/test/**/*.test.ts'],
    },
    resolve: {
        alias: {
            '@addblocker/filter-parser': new URL('./packages/filter-parser/src/index.ts', import.meta.url).pathname,
            '@addblocker/dnr-compiler': new URL('./packages/dnr-compiler/src/index.ts', import.meta.url).pathname,
        },
    },
});
