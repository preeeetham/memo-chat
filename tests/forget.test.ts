import { describe, expect, it } from "vitest";
import { isAffirmative, pendingForgetIn, wantsToForget } from "../src/agent/turn";

describe("forget requests", () => {
  for (const t of ["Forget what I told you about Neon", "please forget our CRM chat", "remove the Postgres conversation from your memory", "stop remembering my salary"])
    it(`asks: ${t}`, () => expect(wantsToForget(t)).toBe(true));
  for (const t of ["Don't forget the HubSpot numbers", "I forgot what you said about Neon", "forget it, compare Neon and Supabase", "Never mind", "delete this chat"])
    it(`not: ${t}`, () => expect(wantsToForget(t)).toBe(false));
  it("yes confirms", () => expect(isAffirmative("Yes, forget them")).toBe(true));
  it("a new question is not a yes", () => expect(isAffirmative("What about Supabase?")).toBe(false));
  it("reads pending ids from the last answer only", () => {
    const prior = [
      { role: "assistant" as const, meta_json: JSON.stringify({ pendingForget: ["a_1"] }) },
      { role: "user" as const, meta_json: null },
      { role: "assistant" as const, meta_json: JSON.stringify({ pendingForget: ["a_2", "a_3"] }) },
    ];
    expect(pendingForgetIn(prior)).toEqual(["a_2", "a_3"]);
    expect(pendingForgetIn(prior.slice(0, 2).concat([{ role: "assistant" as const, meta_json: "{}" }]))).toEqual([]);
  });
});
