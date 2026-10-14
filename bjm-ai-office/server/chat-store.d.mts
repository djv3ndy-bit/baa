export type ChatStore = ((operation: string, args: Record<string, unknown>) => Promise<Record<string, any> | null>) & {
  snapshot(accessHash: string, clientId: string, resource: string): Promise<Record<string, any> | null>;
  close(): Promise<void>;
};
export function chatDatabaseConfiguration(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, unknown>;
export function createChatStore(env?: NodeJS.ProcessEnv | Record<string, string | undefined>, options?: { sqlFactory?: (config: any) => any }): ChatStore;
