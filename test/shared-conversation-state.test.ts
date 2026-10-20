import assert from "node:assert/strict";
import test from "node:test";
import {
  SharedConversationState,
  fusedMessageId,
} from "../src/shared-conversation-state.js";
import type { InboundMessageEvent } from "../src/types.js";

function event(id: string, transportMessageId?: string): InboundMessageEvent {
  return {
    type: "message",
    id,
    ...(transportMessageId ? { transportMessageId } : {}),
    conversation: { id: "room:CaseSensitive", kind: "group" },
    sender: { id: "member:CaseSensitive", displayName: "测试成员" },
    text: "同一条消息",
    timestamp: 1_800_000_000_000,
  };
}

test("shared state preserves opaque transport identities without format guessing", () => {
  const state = new SharedConversationState(":memory:");
  try {
    const mapped = state.mapEvent(event("adapter-a:event-1"));
    assert.equal(mapped.conversation.id, "room:CaseSensitive");
    assert.equal(mapped.sender.id, "member:CaseSensitive");
  } finally {
    state.close();
  }
});

test("shared state can canonicalize adapter-prefixed rooms and members for fusion", () => {
  const state = new SharedConversationState(":memory:", {
    conversationIdResolver: (value) => value.normalize("NFKC").trim().toLocaleLowerCase().split(":").at(-1) ?? value,
    identityIdResolver: (value) => value.normalize("NFKC").trim().toLocaleLowerCase().split(":").at(-1) ?? value,
  });
  try {
    const mapped = state.mapEvent({
      ...event("adapter-a:event-1"),
      conversation: { id: "adapter:room@chatroom", kind: "group" },
      sender: { id: "adapter:member-1", displayName: "成员一" },
    });
    assert.equal(mapped.conversation.id, "room@chatroom");
    assert.equal(mapped.sender.id, "member-1");
  } finally {
    state.close();
  }
});

test("an explicit transport message id fuses events observed by different adapters", () => {
  const state = new SharedConversationState(":memory:");
  try {
    const first = state.prepareInbound(event("adapter-a:event-1", "upstream-42"));
    const second = state.prepareInbound(event("adapter-b:event-9", "upstream-42"));
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.id, second.id);
    const recent = state.store.getRecent("room:CaseSensitive", 10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.transportMessageId, "upstream-42");
  } finally {
    state.close();
  }
});

test("local event ids remain distinct unless an adapter declares a shared transport id", () => {
  const first = fusedMessageId({
    sourceId: "adapter-a:event-1",
    conversationId: "room-1",
    direction: "inbound",
    senderId: "member-1",
    timestamp: 1_800_000_000_000,
    text: "重复文本",
  });
  const second = fusedMessageId({
    sourceId: "adapter-b:event-9",
    conversationId: "room-1",
    direction: "inbound",
    senderId: "member-1",
    timestamp: 1_800_000_000_000,
    text: "重复文本",
  });
  assert.notEqual(first, second);

  const anotherConversation = fusedMessageId({
    sourceId: "adapter-b:event-9",
    transportMessageId: "upstream-42",
    conversationId: "room-2",
    direction: "inbound",
    senderId: "member-1",
    timestamp: 1_800_000_000_000,
    text: "重复文本",
  });
  const originalConversation = fusedMessageId({
    sourceId: "adapter-a:event-1",
    transportMessageId: "upstream-42",
    conversationId: "room-1",
    direction: "inbound",
    senderId: "member-1",
    timestamp: 1_800_000_000_000,
    text: "重复文本",
  });
  assert.notEqual(originalConversation, anotherConversation);
});
