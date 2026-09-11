import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as tf from "@tensorflow/tfjs";
import sharp from "sharp";

// EfficientNet Normalization Layer එකට අවශ්‍ය float32 දත්ත වර්ගය සහ හැඩය නිවැරදිව සැකසීම
class TFNormalizationLayer extends tf.layers.Layer {
    constructor(config?: any) {
        super(config);
    }
    override build(inputShape: tf.Shape | tf.Shape[]) {
        // @ts-ignore
        this.addWeight('mean', [3], 'float32', tf.initializers.zeros(), true);
        // @ts-ignore
        this.addWeight('variance', [3], 'float32', tf.initializers.ones(), true);
        // @ts-ignore
        this.addWeight('count', [], 'int32', tf.initializers.zeros(), false);
        super.build(inputShape);
    }
    static get className() {
        return "Normalization";
    }
}
tf.serialization.registerClass(TFNormalizationLayer);

// Local file system එකෙන් model.json සහ weight files load කර ගැනීමට fetch override කිරීම
const originalFetch = global.fetch;
global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlString = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (urlString.startsWith("file://")) {
        const filePath = fileURLToPath(urlString);
        try {
            const data = await fs.readFile(filePath);
            return new Response(data);
        } catch (err) {
            return new Response("File not found", { status: 404, statusText: "Not Found" });
        }
    }
    return originalFetch(input, init);
};

export type PlantModelName =
    | "apple"
    | "blueberry"
    | "cauliflower"
    | "chilli"
    | "lemon"
    | "maize"
    | "tea"
    | "tomato"
    | "banana";

export interface PlantModel {
    model: tf.LayersModel;
    classes: string[];
}

export interface LoadedPlantModel extends PlantModel {
    plant: PlantModelName;
}

interface ModelManifestEntry {
    modelUrl: string;
    classesUrl: string;
    inputSize: number;
}

interface ModelManifest {
    models: Record<string, ModelManifestEntry>;
}

const cache = new Map<string, Promise<PlantModel>>();

export async function loadPlantModel(
    plant: PlantModelName,
    modelsDirectory = path.resolve("../models"),
): Promise<PlantModel> {
    const key = path.resolve(modelsDirectory, plant);
    const existing = cache.get(key);
    if (existing) return existing;

    const loading = loadPlantModelUncached(plant, key);
    cache.set(key, loading);
    return loading;
}

export async function loadAllPlantModels(
    modelsDirectory = path.resolve("../models"),
): Promise<LoadedPlantModel[]> {
    const manifestPath = path.join(path.resolve(modelsDirectory), "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ModelManifest;
    const plants = Object.keys(manifest.models) as PlantModelName[];

    return Promise.all(
        plants.map(async (plant) => ({
            plant,
            ...(await loadPlantModel(plant, modelsDirectory)),
        })),
    );
}

async function loadPlantModelUncached(
    plant: PlantModelName,
    modelDirectory: string,
): Promise<PlantModel> {
    const manifestPath = path.join(path.dirname(modelDirectory), "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ModelManifest;
    const entry = manifest.models[plant];
    if (!entry) throw new Error(`No exported TFJS model is available for ${plant}`);

    const modelJsonPath = pathToFileURL(path.join(modelDirectory, "model.json")).href;

    const [model, classes] = await Promise.all([
        tf.loadLayersModel(modelJsonPath),
        fs.readFile(path.join(modelDirectory, "classes.json"), "utf8")
            .then((contents: string) => JSON.parse(contents) as string[]),
    ]);
    return { model, classes };
}

export async function imageToTensor(
    image: string | Buffer,
    size = 256
): Promise<tf.Tensor4D> {
    const imageBuffer = Buffer.isBuffer(image) ? image : await fs.readFile(image);

    const { data, info } = await sharp(imageBuffer)
        .resize(size, size, { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    return tf.tidy(() => {
        const tensor = tf.tensor3d(
            new Float32Array(new Uint8Array(data)),
            [info.height, info.width, 3],
            "float32"
        );
        return tensor.expandDims(0) as tf.Tensor4D;
    });
}

export async function predictPlant(
    model: PlantModel,
    image: string | Buffer,
    topK = 5,
) {
    const input = await imageToTensor(image);
    let output: tf.Tensor | null = null;
    try {
        output = model.model.predict(input) as tf.Tensor;
        const probabilities = Array.from(await output.data()) as number[];
        const indices = probabilities
            .map((confidence, index) => ({ index, confidence }))
            .sort((left, right) => right.confidence - left.confidence)
            .slice(0, topK);
        return indices.map(({ index, confidence }) => ({
            className: model.classes[index] ?? `class_${index}`,
            confidence,
        }));
    } finally {
        input.dispose();
        output?.dispose();
    }
}