export interface DnrHeaderEdit {
    header: string;
    operation: 'append' | 'set' | 'remove';
    value?: string;
}

export interface DnrAction {
    type: 'block' | 'allow' | 'allowAllRequests' | 'redirect' | 'upgradeScheme' | 'modifyHeaders';
    redirect?: {
        extensionPath?: string;
        transform?: { queryTransform?: { removeParams?: string[] } };
    };
    responseHeaders?: DnrHeaderEdit[];
}

export interface DnrCondition {
    urlFilter?: string;
    regexFilter?: string;
    requestDomains?: string[];
    excludedRequestDomains?: string[];
    initiatorDomains?: string[];
    excludedInitiatorDomains?: string[];
    resourceTypes?: string[];
    excludedResourceTypes?: string[];
    domainType?: 'firstParty' | 'thirdParty';
    requestMethods?: string[];
    excludedRequestMethods?: string[];
    isUrlFilterCaseSensitive?: boolean;
}

export interface DnrRule {
    id: number;
    priority: number;
    action: DnrAction;
    condition: DnrCondition;
}

export interface CompileStats {
    inputFilters: number;
    /** Filters that are cosmetic-scoped, not network rules at all. */
    cosmeticScoped: number;
    unconvertible: number;
    unconvertibleReasons: Record<string, number>;
    badfilterRemoved: number;
    rulesBeforeMerge: number;
    rulesAfterMerge: number;
    regexRules: number;
    unsafeRules: number;
    mergedGroups: number;
    /** Filters recovered by expanding a `example.*` wildcard. */
    tldExpanded: number;
}

export interface CompileResult {
    rules: DnrRule[];
    stats: CompileStats;
    /** Maps a rule id back to the filters that produced it. */
    sourceMap: Map<number, string[]>;
}
