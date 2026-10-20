import assert from "node:assert/strict";
import test from "node:test";
import { formatBeijingMinute, formatBeijingTimestamp } from "../src/time.js";

test("chat timestamps are formatted in Beijing time", () => {
  const timestamp = Date.parse("2026-08-13T05:47:52.000Z");
  assert.equal(formatBeijingTimestamp(timestamp), "2026-08-13T13:47:52+08:00");
  assert.equal(formatBeijingMinute(timestamp), "2026-08-13T13:47+08:00");
});
