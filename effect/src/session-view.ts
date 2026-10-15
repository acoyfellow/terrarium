import type { Message } from "@earendil-works/pi-ai";

export interface SessionTurn {
  readonly box: string;
  readonly entries: number;
  readonly answer: string;
  readonly toolCalls: ReadonlyArray<string>;
  readonly userTurns: number;
  readonly stop: string;
  readonly error: string;
  readonly roles: ReadonlyArray<string>;
}

const blocksText = (content: Message["content"]): string => {
  if (!Array.isArray(content)) return String(content);

  return content.flatMap((block) => ("text" in block && block.type === "text" ? [block.text] : [])).join("\n");
};

export const sessionView = (messages: ReadonlyArray<Message>, entriesBefore: number, box: string): SessionTurn => {
  const assistants = messages.filter((message): message is Extract<Message, { role: "assistant" }> => message.role === "assistant");
  const last = assistants.at(-1);
  const newMessages = messages.slice(Math.min(entriesBefore, messages.length));
  const toolCalls = newMessages.flatMap((message) => (message.role === "assistant" ? message.content.flatMap((block) => (block.type === "toolCall" ? [`${block.name} ${JSON.stringify(block.arguments).slice(0, 160)}`] : [])) : []));

  return { box, entries: messages.length, answer: last === undefined ? "" : blocksText(last.content), toolCalls, userTurns: messages.filter((message) => message.role === "user").length, stop: last?.stopReason ?? "", error: (last?.errorMessage ?? "").slice(0, 300), roles: newMessages.map((message) => message.role) };
};
