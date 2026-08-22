export type SessionBinding = {
  threadId: string;
  parentChannelId: string;
  sessionId: string;
  directory: string;
  title: string;
  createdBy: string;
  createdAt: string;
  lastPublishedAssistantMessageId?: string;
};
