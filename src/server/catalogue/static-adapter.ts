import rawCatalogue from "@/domain/commands/catalogue.json" with { type: "json" };
import rawRecipes from "@/server/recipes/recipes.json" with { type: "json" };
import { assertValidCatalogue } from "@/domain/contract/validate-catalogue";
import type { RecipeBook } from "@/domain/contract/types";
import type { CommandRepository, RecipeRepository, CategoryRepository } from "./port";

const catalogue=assertValidCatalogue(rawCatalogue);
const recipes=rawRecipes as RecipeBook;
export const staticCommandRepository:CommandRepository={async listPublicCommands(){return catalogue.commands.filter(c=>c.maturity!=="deprecated");},async getById(id){return catalogue.commands.find(c=>c.id===id)??null;}};
export const staticRecipeRepository:RecipeRepository={async getById(recipeId){return recipes.recipes.find(r=>r.recipeId===recipeId)??null;}};
export const staticCategoryRepository:CategoryRepository={async listActive(){return [];}};
