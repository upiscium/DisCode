export type OpenCodeModelSelection = {
  providerID: string;
  modelID: string;
};

export type SessionBinding = {
  threadId: string;
  parentChannelId: string;
  hostId: string;
  sessionId: string;
  directory: string;
  title: string;
  createdBy: string;
  createdAt: string;
  model?: OpenCodeModelSelection;
  agent?: string;
  lastPublishedAssistantMessageId?: string;
  headerMessageId?: string;
  todoMessageId?: string;
};
