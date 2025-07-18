import EventEmitter, { once } from "events";
import { type BedrockChunk, type ExtendedBlock } from "prismarine-chunk";
import { Vec3 } from "vec3";
import { type Biome } from "prismarine-biome";


function columnKeyXZ(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

function posInChunk(pos: Vec3): Vec3 {
  return new Vec3(Math.floor(pos.x) & 15, Math.floor(pos.y), Math.floor(pos.z) & 15);
}

export class BedrockWorld extends EventEmitter {
  savingQueue!: Map<any, any>;
  unloadQueue!: Map<any, any>;
  finishedSaving!: Promise<any>;
  currentlySaving!: boolean;
  columns: { [key: string]: BedrockChunk } = {};
  chunkGenerator: any | null;
  storageProvider: any | null;
  savingInterval: number;
  savingInt: any;

  constructor(
    chunkGenerator: any | null,
    storageProvider = null,
    savingInterval = 1000
  ) {
    super();
    this.savingQueue = new Map();
    this.unloadQueue = new Map();
    this.finishedSaving = Promise.resolve();
    this.currentlySaving = false; // semaphore for saving
    this.columns = {};
    this.chunkGenerator = chunkGenerator;
    this.storageProvider = storageProvider;
    this.savingInterval = savingInterval;
    //this.sync = new WorldSync(this)
    if (storageProvider && savingInterval !== 0) this.startSaving();
  }

  initialize(iniFunc: (x: number, y: number, z: number) => any, length: number, width: number, height = 256, iniPos = new Vec3(0, 0, 0)) {
    function inZone(x: number, y: number, z: number) {
      if (x >= width || x < 0) { return false }
      if (z >= length || z < 0) {
        return false
      }
      if (y >= height || y < 0) { return false }
      return true
    }
    const ps = []
    const iniPosInChunk = posInChunk(iniPos)
    const chunkLength = Math.ceil((length + iniPosInChunk.z) / 16)
    const chunkWidth = Math.ceil((width + iniPosInChunk.x) / 16)
    for (let chunkZ = 0; chunkZ < chunkLength; chunkZ++) {
      const actualChunkZ = chunkZ + Math.floor(iniPos.z / 16)
      for (let chunkX = 0; chunkX < chunkWidth; chunkX++) {
        const actualChunkX = chunkX + Math.floor(iniPos.x / 16)
        ps.push(this.getColumn(actualChunkX, actualChunkZ)
          .then(chunk => {
            const offsetX = chunkX * 16 - iniPosInChunk.x
            const offsetZ = chunkZ * 16 - iniPosInChunk.z
            chunk.initialize((x: number, y: number, z: number) => inZone(x + offsetX, y - iniPos.y, z + offsetZ) ? iniFunc(x + offsetX, y - iniPos.y, z + offsetZ) : null)
            return this.setColumn(actualChunkX, actualChunkZ, chunk)
          })
          .then(() => ({ chunkX: actualChunkX, chunkZ: actualChunkZ })))
      }
    }
    return Promise.all(ps)
  }

  getLoadedColumn(chunkX: number, chunkZ: number) {
    const key = columnKeyXZ(chunkX, chunkZ);
    return this.columns[key];
  }


  async getColumn(chunkX: number, chunkZ: number) {
    await Promise.resolve();
    const key = columnKeyXZ(chunkX, chunkZ);

    if (!this.columns[key]) {
      let chunk = null;
      // TODO: Future integration with bedrock-provider for persistent storage
      // See: https://github.com/PrismarineJS/bedrock-provider/tree/master
      if (this.storageProvider != null) {
        const data = await this.storageProvider.load(chunkX, chunkZ);
        if (data != null) {
          chunk = data;
        }
      }
      const loaded = chunk != null;
      if (!loaded && this.chunkGenerator) {
        chunk = this.chunkGenerator(chunkX, chunkZ);
      }
      if (chunk != null) {
        await this.setColumn(chunkX, chunkZ, chunk, !loaded);
      }
    }

    return this.columns[key];
  }

  _emitBlockUpdate(oldBlock: ExtendedBlock, newBlock: ExtendedBlock, position: Vec3) {
    oldBlock.position = position.floored();
    newBlock.position = oldBlock.position;
    this.emit("blockUpdate", oldBlock, newBlock);
    this.emit(`blockUpdate:${position}`, oldBlock, newBlock);
  }

  setLoadedColumn(chunkX: number, chunkZ: number, chunk: BedrockChunk, save = true) {
    const key = columnKeyXZ(chunkX, chunkZ);
    this.columns[key] = chunk;

    const columnCorner = new Vec3(chunkX * 16, 0, chunkZ * 16);
    this.emit("chunkColumnLoad", columnCorner);

    // TODO: Future integration with bedrock-provider for persistent storage
    // See: https://github.com/PrismarineJS/bedrock-provider/tree/master
    if (this.storageProvider && save) {
      this.queueSaving(chunkX, chunkZ);
    }
  }

  async setColumn(chunkX: number, chunkZ: number, chunk: BedrockChunk, save = true) {
    await Promise.resolve();
    this.setLoadedColumn(chunkX, chunkZ, chunk, save);
  }

  unloadColumn(chunkX: number, chunkZ: number) {
    const key = columnKeyXZ(chunkX, chunkZ);
    if (this.storageProvider && this.savingQueue.has(key)) {
      this.unloadQueue.set(key, { chunkX, chunkZ });
    } else {
      this.forceUnloadColumn(key, chunkX, chunkZ);
    }
  }

  forceUnloadColumn(key: string, chunkX: number, chunkZ: number) {
    if (this.unloadQueue.has(key)) {
      this.unloadQueue.delete(key);
    }
    delete this.columns[key];
    const columnCorner = new Vec3(chunkX * 16, 0, chunkZ * 16);
    this.emit("chunkColumnUnload", columnCorner);
  }

  // TODO: Future integration with bedrock-provider for persistent storage
  // See: https://github.com/PrismarineJS/bedrock-provider/tree/master
  // Storage functionality preserved for future use
  async saveNow() {
    if (this.savingQueue.size === 0) {
      return;
    }
    // We could set a limit on the number of chunks to save at each
    // interval. The set structure is maintaining the order of insertion
    for (const [key, { chunkX, chunkZ }] of this.savingQueue.entries()) {
      this.finishedSaving = Promise.all([
        this.finishedSaving,
        this.storageProvider.save(chunkX, chunkZ, this.columns[key]),
      ]);
    }
    await this.finishedSaving;
    this.savingQueue.clear();
    for (const [key, { chunkX, chunkZ }] of this.unloadQueue.entries()) {
      this.forceUnloadColumn(key, chunkX, chunkZ);
    }
    this.emit("doneSaving");
  }

  startSaving() {
    this.savingInt = setInterval(async () => {
      if (this.currentlySaving === false) {
        this.currentlySaving = true;
        await this.saveNow();
        this.currentlySaving = false;
      }
    }, this.savingInterval);
  }

  async waitSaving() {
    await this.saveNow();
    if (this.savingQueue.size > 0) {
      await once(this, "doneSaving");
    }
    await this.finishedSaving;
  }

  stopSaving() {
    clearInterval(this.savingInt);
  }

  queueSaving(chunkX: number, chunkZ: number) {
    this.savingQueue.set(columnKeyXZ(chunkX, chunkZ), { chunkX, chunkZ });
  }

  saveAt(pos: Vec3) {
    const chunkX = Math.floor(pos.x / 16);
    const chunkZ = Math.floor(pos.z / 16);
    if (this.storageProvider) {
      this.queueSaving(chunkX, chunkZ);
    }
  }

  getColumns() {
    return Object.entries(this.columns).map(([key, column]) => {
      const parts = key.split(",");
      return {
        chunkX: parts[0],
        chunkZ: parts[1],
        column,
      };
    });
  }

  getLoadedColumnAt(pos: Vec3) {
    const chunkX = Math.floor(pos.x / 16);
    const chunkZ = Math.floor(pos.z / 16);
    return this.getLoadedColumn(chunkX, chunkZ);
  }

  async getColumnAt(pos: Vec3) {
    const chunkX = Math.floor(pos.x / 16);
    const chunkZ = Math.floor(pos.z / 16);
    return this.getColumn(chunkX, chunkZ);
  }

  async setBlock(pos: Vec3, block: ExtendedBlock) {
    const chunk = await this.getColumnAt(pos);
    const pInChunk = posInChunk(pos);
    const oldBlock = chunk.getBlock(pInChunk);
    chunk.setBlock(pInChunk, block);
    this.saveAt(pos);
    this._emitBlockUpdate(oldBlock, block, pos);
  }

  async getBlock(pos: Vec3) {
    const block = (await this.getColumnAt(pos)).getBlock(posInChunk(pos));
    block.position = pos.floored();
    return block;
  }

  async getBlockStateId(pos: Vec3) {
    return (await this.getColumnAt(pos)).getBlockStateId(posInChunk(pos));
  }

  async getBlockType(pos: Vec3) {
    return (await this.getColumnAt(pos)).getBlock(posInChunk(pos)).type;
  }

  async getBlockLight(pos: Vec3) {
    return (await this.getColumnAt(pos)).getBlockLight(posInChunk(pos));
  }

  async getSkyLight(pos: Vec3) {
    return (await this.getColumnAt(pos)).getSkyLight(posInChunk(pos));
  }

  async getBiome(pos: Vec3) {
    return (await this.getColumnAt(pos)).getBiome(posInChunk(pos));
  }

  async setBlockStateId(pos: Vec3, stateId: number) {
    const chunk = await this.getColumnAt(pos);
    const pInChunk = posInChunk(pos);
    const oldBlock = chunk.getBlock(pInChunk);
    chunk.setBlockStateId(pInChunk, stateId);
    this.saveAt(pos);
    this._emitBlockUpdate(oldBlock, chunk.getBlock(pInChunk), pos);
  }

  async setBlockLight(pos: Vec3, light: number) {
    const chunk = await this.getColumnAt(pos);
    const pInChunk = posInChunk(pos);
    const oldBlock = chunk.getBlock(pInChunk);
    chunk.setBlockLight(pInChunk, light);
    this.saveAt(pos);
    this._emitBlockUpdate(oldBlock, chunk.getBlock(pInChunk), pos);
  }

  async setSkyLight(pos: Vec3, light: number) {
    const chunk = await this.getColumnAt(pos);
    const pInChunk = posInChunk(pos);
    const oldBlock = chunk.getBlock(pInChunk);
    chunk.setSkyLight(pInChunk, light);
    this.saveAt(pos);
    this._emitBlockUpdate(oldBlock, chunk.getBlock(pInChunk), pos);
  }

  async setBiome(pos: Vec3, biome: Biome) {
    const chunk = await this.getColumnAt(pos);
    const pInChunk = posInChunk(pos);
    const oldBlock = chunk.getBlock(pInChunk);
    chunk.setBiome(pInChunk, biome);
    this.saveAt(pos);
    this._emitBlockUpdate(oldBlock, chunk.getBlock(pInChunk), pos);
  }

  /**
   * Clean up all resources and pending operations
   */
  async cleanup() {
    // Stop the saving interval
    this.stopSaving();
    
    // Wait for pending saves to complete
    try {
      await this.waitSaving();
    } catch (error) {
      console.error('Error waiting for saves to complete:', error);
    }
    
    // Clear all columns
    for (const key in this.columns) {
      delete this.columns[key];
    }
    
    // Clear all queues
    this.savingQueue.clear();
    this.unloadQueue.clear();
    
    // Remove all event listeners
    this.removeAllListeners();
    
    // Nullify external references
    this.chunkGenerator = null;
    this.storageProvider = null;
  }
}