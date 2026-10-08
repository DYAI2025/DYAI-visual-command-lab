import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const ROOT=fs.realpathSync(".");
const SRC=path.join(ROOT,"src");
const CODE=/\.(?:[cm]?[jt]sx?)$/;
const EXTENSIONS=["",".ts",".tsx",".js",".jsx",".mjs",".cjs",".json"];
const filesUnder=(dir)=>fs.readdirSync(dir,{withFileTypes:true}).flatMap((entry)=>{const full=path.join(dir,entry.name);return entry.isDirectory()?filesUnder(full):(CODE.test(entry.name)?[full]:[]);});
const GAP=String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*`;
const SPECIFIER=new RegExp(String.raw`(?:\bfrom${GAP}|\bimport${GAP}(?:\(${GAP})?|\brequire${GAP}\(${GAP})(["'\x60])([^"'\x60]+)\1`,"g");
const specifiersOf=(source)=>[...source.matchAll(SPECIFIER)].map((m)=>m[2]);
function resolveSpecifier(fromFile,specifier){let base;if(specifier.startsWith("@/"))base=path.join(SRC,specifier.slice(2));else if(specifier.startsWith("."))base=path.resolve(path.dirname(fromFile),specifier);else return null;for(const candidate of [...EXTENSIONS.map(ext=>base+ext),...EXTENSIONS.slice(1).map(ext=>path.join(base,`index${ext}`))])if(fs.existsSync(candidate)&&fs.statSync(candidate).isFile())return candidate;return `${base} (unresolved)`;}
function reachableFrom(entries){const seen=new Set(),queue=[...entries];while(queue.length){const file=queue.pop();if(seen.has(file))continue;seen.add(file);if(!CODE.test(file)||file.endsWith(" (unresolved)"))continue;for(const specifier of specifiersOf(fs.readFileSync(file,"utf8"))){const target=resolveSpecifier(file,specifier);if(target)queue.push(target);}}return [...seen];}
const rel=(file)=>path.relative(ROOT,file);
const clientEntries=filesUnder(SRC).filter((file)=>/^\s*["']use client["'];/.test(fs.readFileSync(file,"utf8")));
test("client components cannot reach server, recipe or model implementation",()=>{assert.ok(clientEntries.length>0);const violations=reachableFrom(clientEntries).map(rel).filter((file)=>/^src\/server\//i.test(file)||/recipe-book\.schema\.json$/i.test(file)||/model-registry\.schema\.json$/i.test(file)||file.endsWith(" (unresolved)"));assert.deepEqual(violations,[]);});
test("domain code never imports server modules",()=>{const violations=reachableFrom(filesUnder(path.join(SRC,"domain"))).map(rel).filter((file)=>/^src\/server\//i.test(file));assert.deepEqual(violations,[]);});
test("server route may read repository port while client remains data-only",()=>{const page=fs.readFileSync(path.join(SRC,"app","[locale]","page.tsx"),"utf8");assert.match(page,/commandRepository/);const client=fs.readFileSync(path.join(SRC,"prototype","visual-command","ClickDummy.tsx"),"utf8");assert.doesNotMatch(client,/server\/catalogue|DATABASE_URL|openrouter/i);});
