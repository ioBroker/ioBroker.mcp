export interface McpAdapterConfig extends ioBroker.AdapterConfig {
    webInstance: string;
    port: number | string;
    bind: string;
    auth: boolean;
    secure: boolean;
    /** Allow the `set_state`/`set_states` tools to write states (default: true). */
    allowSetState: boolean;
    /** Allow the object/file changing tools (`set_object`, `delete_object`, `create_state`, `create_scene`, `write_file`, `delete_file`, `rename_file`, `mkdir`) (default: false). */
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
