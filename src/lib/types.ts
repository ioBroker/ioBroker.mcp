export interface McpAdapterConfig extends ioBroker.AdapterConfig {
    port: number | string;
    bind: string;
    auth: boolean;
    secure: boolean;
    certPublic: string;
    certPrivate: string;
    certChained: string;
    defaultUser: string;
    certificates?: ioBroker.Certificates;
    leConfig?: boolean;
}

export interface McpAdapter extends ioBroker.Adapter {
    config: McpAdapterConfig;
}
