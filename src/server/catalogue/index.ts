import { staticCategoryRepository, staticCommandRepository, staticRecipeRepository } from "./static-adapter";
export const commandRepository=staticCommandRepository;
export const recipeRepository=staticRecipeRepository;
export const categoryRepository=staticCategoryRepository;
export type { CommandRepository, RecipeRepository, CategoryRepository, CategoryRecord } from "./port";
