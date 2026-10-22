import { describe, expect, it } from "vitest";
import {
  availableFeatures,
  combinedSystemPrompt,
  effectiveFeatures,
  emptySettings,
  parseFeatures,
  parseParams,
  serializeFeatures,
  serializeParams,
  toCompletionOptions,
} from "./chatOptions";
import type { OpenWebUiModel } from "./openWebUiClient";

const model = (over: Partial<OpenWebUiModel["capabilities"]> = {}): OpenWebUiModel => ({
  id: "m",
  name: "M",
  description: null,
  tags: [],
  workspace: false,
  capabilities: { vision: true, webSearch: true, imageGeneration: true, codeInterpreter: true, ...over },
});

describe("params storage", () => {
  it("keeps an untouched chat at NULL and round-trips what was set", () => {
    expect(serializeParams(emptySettings().params)).toBeNull();
    const params = { system: "Be brief", temperature: 0.3, top_p: null, max_tokens: 256, seed: 0, stop: ["END"] };
    expect(parseParams(serializeParams(params))).toEqual({ ...params });
  });

  it("treats a seed of 0 and a temperature of 0 as set values", () => {
    const back = parseParams(serializeParams({ ...emptySettings().params, temperature: 0, seed: 0 }));
    expect(back.temperature).toBe(0);
    expect(back.seed).toBe(0);
  });

  it("shrugs off damaged or foreign JSON", () => {
    expect(parseParams("{nope")).toEqual(emptySettings().params);
    expect(parseParams('{"temperature":"hot","stop":[1,"a"],"system":"  "}')).toEqual({
      ...emptySettings().params,
      stop: ["a"],
    });
    expect(parseFeatures("[]")).toEqual(emptySettings().features);
  });
});

describe("feature storage", () => {
  it("stores only the switches that are on", () => {
    expect(serializeFeatures(emptySettings().features)).toBeNull();
    const features = { ...emptySettings().features, webSearch: true, toolIds: ["calc"] };
    expect(JSON.parse(serializeFeatures(features)!)).toEqual({ webSearch: true, toolIds: ["calc"] });
    expect(parseFeatures(serializeFeatures(features))).toEqual(features);
  });
});

describe("toCompletionOptions", () => {
  it("leaves unset parameters out and passes the rest on", () => {
    const settings = emptySettings();
    settings.params.temperature = 0.5;
    settings.features.webSearch = true;
    const options = toCompletionOptions(settings);
    expect(options).toMatchObject({ temperature: 0.5, webSearch: true, stop: [], toolIds: [] });
    expect(options.topP).toBeUndefined();
    expect(options.maxTokens).toBeUndefined();
  });
});

describe("combinedSystemPrompt", () => {
  it("puts the folder's prompt before the chat's", () => {
    expect(combinedSystemPrompt("Folder rules", "Chat rules")).toBe("Folder rules\n\nChat rules");
    expect(combinedSystemPrompt(null, "Only chat")).toBe("Only chat");
    expect(combinedSystemPrompt("  ", "")).toBeNull();
    expect(combinedSystemPrompt(undefined, undefined)).toBeNull();
  });
});

describe("available features", () => {
  it("needs both the model's capability and the server's switch", () => {
    const all = availableFeatures(model(), null);
    expect(all).toEqual({ webSearch: true, imageGeneration: true, codeInterpreter: true, memory: true });

    const limited = availableFeatures(model({ webSearch: false }), {
      webSearch: true,
      imageGeneration: false,
      codeInterpreter: null,
      memory: false,
    });
    expect(limited).toEqual({ webSearch: false, imageGeneration: false, codeInterpreter: true, memory: false });
  });

  it("does not send a switch that is on but no longer offered", () => {
    const features = { ...emptySettings().features, webSearch: true, memory: true, toolIds: ["t"] };
    const sent = effectiveFeatures(features, { webSearch: false, imageGeneration: true, codeInterpreter: true, memory: true });
    expect(sent).toMatchObject({ webSearch: false, memory: true, toolIds: ["t"] });
  });
});
