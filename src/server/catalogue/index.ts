import { staticCategoryRepository, staticCommandRepository, staticRecipeRepository } from "./static-adapter.ts";
export const commandRepository=staticCommandRepository;
export const recipeRepository=staticRecipeRepository;
export const categoryRepository=staticCategoryRepository;
export type { CommandRepository, RecipeRepository, CategoryRepository, CategoryRecord } from "./port.ts";
