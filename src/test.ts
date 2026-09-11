import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    loadPlantModel,
    predictPlant,
} from "./services/aimodels";

async function main() {
    const modelsPath = path.resolve("src/models");
    const imagePath = path.resolve("D:/fc project data/dataset/images/apple_healthy/000001.jpeg");

    const model = await loadPlantModel("apple", modelsPath);
    const imageBuffer = await fs.readFile(imagePath);

    const predictions = await predictPlant(model, imageBuffer, 5);

    console.log(predictions);
}

main().catch(console.error);