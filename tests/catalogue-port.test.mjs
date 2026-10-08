import assert from "node:assert/strict";
import test from "node:test";
import { commandRepository, categoryRepository } from "../src/server/catalogue/index.ts";
test("bootstrap repository serves the 12 VC-01 commands", async()=>{const commands=await commandRepository.listPublicCommands();assert.equal(commands.length,12);assert.deepEqual([...new Set(commands.map(c=>c.lane))].sort(),["explain","play","polish"]);});
test("category is not collapsed into lane", async()=>{assert.deepEqual(await categoryRepository.listActive(),[]);});
