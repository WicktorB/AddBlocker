/**
 * Runs AdGuard's declarative converter over the same lists, so the two
 * approaches are measured on identical input.
 *
 * Note: the converter lives in @adguard/tsurlfilter 5.x. It was removed from
 * the 6.x entry points — see docs/adr/0001 for why that matters.
 */

import { DeclarativeFilterConverter, Filter } from '@adguard/tsurlfilter/es/declarative-converter';
import { FilterList } from '@adguard/tsurlfilter';

export interface AdguardResult {
    rules: number;
    regexRules: number;
    unsafeRules: number;
    /** Rules the converter refused, by error type. */
    errors: number;
    errorsByType: Record<string, number>;
    /** Rules discarded to respect the declared limits. */
    limitations: number;
    durationMs: number;
}

const UNSAFE_ACTIONS = new Set(['redirect', 'modifyHeaders']);

export async function convertWithAdguard(
    filterId: number,
    content: string,
    maxNumberOfRules: number,
): Promise<AdguardResult> {
    const started = Date.now();

    const filter = new Filter(
        filterId,
        { getContent: async () => new FilterList(content) },
        // Trusted: these are the upstream lists, same trust level the real
        // extension would grant them.
        true,
    );

    const converter = new DeclarativeFilterConverter();
    // maxNumberOfUnsafeRules is rejected for static rulesets: the unsafe cap is
    // a dynamic-rule concept, static rules are vetted at install time.
    const result = await converter.convertStaticRuleSet(filter, {
        resourcesPath: '/web_accessible_resources',
        maxNumberOfRules,
        maxNumberOfRegexpRules: 1000,
    });

    const declarativeRules = await result.ruleSet.getDeclarativeRules();

    const errorsByType: Record<string, number> = {};
    for (const error of result.errors) {
        const name = error.constructor?.name ?? 'Unknown';
        errorsByType[name] = (errorsByType[name] ?? 0) + 1;
    }

    return {
        rules: declarativeRules.length,
        regexRules: declarativeRules.filter((r) => r.condition?.regexFilter !== undefined).length,
        unsafeRules: declarativeRules.filter((r) => UNSAFE_ACTIONS.has(r.action?.type as string)).length,
        errors: result.errors.length,
        errorsByType,
        limitations: result.limitations.length,
        durationMs: Date.now() - started,
    };
}
