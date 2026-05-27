export interface McpAdapterConfig extends ioBroker.AdapterConfig {
    webInstance: string;
    port: number | string;
    bind: string;
    auth: boolean;
    secure: boolean;
    /** Allow the `set_state` tool to write states (default: true). */
    allowSetState: boolean;
    /** Allow the `set_object`/`write_file` tools to change objects/files (default: false). */
    allowObjectChange: boolean;
    certPublic: string;
    certPrivate: string;
    certChained: string;
    defaultUser?: `system.user.${string}`;
    certificates?: ioBroker.Certificates;
    leConfig?: boolean;
}

export interface McpAdapter extends ioBroker.Adapter {
    config: McpAdapterConfig;
}
