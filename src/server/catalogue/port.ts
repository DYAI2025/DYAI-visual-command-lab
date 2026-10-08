import type { CommandRecord, Recipe } from "@/domain/contract/types";

export interface CategoryRecord { id:string; slug:string; display:{en:{name:string;description:string};de:{name:string;description:string}}; archived:boolean; }
export interface CommandRepository { listPublicCommands():Promise<readonly CommandRecord[]>; getById(id:string):Promise<CommandRecord|null>; }
export interface RecipeRepository { getById(recipeId:string):Promise<Recipe|null>; }
export interface CategoryRepository { listActive():Promise<readonly CategoryRecord[]>; }
