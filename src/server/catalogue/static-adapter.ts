import rawCatalogue from "../../domain/commands/catalogue.json" with { type: "json" };
import rawRecipes from "../recipes/recipes.json" with { type: "json" };
import { assertValidCatalogue } from "../../domain/contract/validate-catalogue.ts";
import { matchCommandSlash } from "../../domain/contract/contract.ts";
import type { RecipeBook } from "../../domain/contract/types.ts";
import type { CommandRepository, RecipeRepository, CategoryRepository } from "./port.ts";

const catalogue=assertValidCatalogue(rawCatalogue);
const recipes=rawRecipes as RecipeBook;
export const staticCommandRepository:CommandRepository={async listPublicCommands(){return catalogue.commands.filter(c=>c.maturity!=="deprecated");},async getById(id){return catalogue.commands.find(c=>c.id===id)??null;},async findBySlash(slash,options){return matchCommandSlash(catalogue.commands,slash,options)??null;}};
export const staticRecipeRepository:RecipeRepository={async getById(recipeId){return recipes.recipes.find(r=>r.recipeId===recipeId)??null;}};
export const staticCategoryRepository:CategoryRepository={async listActive(){return [];}};
