export type SessionBinding = {
  threadId: string;
  parentChannelId: string;
  hostId: string;
  sessionId: string;
  directory: string;
  title: string;
  createdBy: string;
  createdAt: string;
  lastPublishedAssistantMessageId?: string;
  headerMessageId?: string;
};
