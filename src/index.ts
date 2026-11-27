import { SKILL_FILES, SKILLS } from "ega-plugin/generated-catalog";
import { createStaticCatalog } from "./catalog";
import { createWorker } from "./worker";

const worker = createWorker(createStaticCatalog({ skills: SKILLS, files: SKILL_FILES }));

export const apiHandler = worker.apiHandler;
export default worker;
