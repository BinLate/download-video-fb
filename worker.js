/**
 * FFmpeg Module Worker
 * Runs in a module Web Worker context ({ type: "module" }).
 * Uses dynamic import() to load the ES module ffmpeg-core.js,
 * which internally uses import.meta.url to locate the WASM file.
 *
 * Must be loaded as: new Worker(url, { type: "module" })
 */

// Message types (must match offscreen/index.ts)
var MessageType = {
  LOAD: "LOAD",
  EXEC: "EXEC",
  WRITE_FILE: "WRITE_FILE",
  READ_FILE: "READ_FILE",
  DELETE_FILE: "DELETE_FILE",
  RENAME: "RENAME",
  CREATE_DIR: "CREATE_DIR",
  LIST_DIR: "LIST_DIR",
  DELETE_DIR: "DELETE_DIR",
  ERROR: "ERROR",
  PROGRESS: "PROGRESS",
  LOG: "LOG",
  MOUNT: "MOUNT",
  UNMOUNT: "UNMOUNT",
}

var ERRORS = {
  UNKNOWN_MESSAGE: new Error("unknown message type"),
  NOT_LOADED: new Error("ffmpeg is not loaded, call load() first"),
  TERMINATED: new Error("called FFmpeg.terminate()"),
}

var ffmpegCore = null

/**
 * Load FFmpeg core via dynamic import() (module worker API).
 * ffmpeg-core.js is an ES module that uses import.meta.url,
 * so it must be loaded with import() rather than importScripts().
 */
async function loadFFmpeg(data) {
  var coreURL = data.coreURL
  var wasmURL = data.wasmURL || coreURL.replace(/\.js$/, ".wasm")

  var isFirstLoad = !ffmpegCore

  // Load ffmpeg-core.js as an ES module — it uses import.meta.url internally
  var module = await import(coreURL)
  var createFFmpegCore = module.default

  ffmpegCore = await createFFmpegCore({
    mainScriptUrlOrBlob: coreURL + "#" + btoa(JSON.stringify({ wasmURL: wasmURL })),
  })

  ffmpegCore.setLogger(function (log) {
    self.postMessage({ type: MessageType.LOG, data: log })
  })

  ffmpegCore.setProgress(function (progress) {
    self.postMessage({ type: MessageType.PROGRESS, data: progress })
  })

  return isFirstLoad
}

function executeFFmpeg(data) {
  var args = data.args
  var timeout = data.timeout !== undefined ? data.timeout : -1
  ffmpegCore.setTimeout(timeout)
  ffmpegCore.exec.apply(ffmpegCore, args)
  var result = ffmpegCore.ret
  ffmpegCore.reset()
  return result
}

function writeFile(data) {
  ffmpegCore.FS.writeFile(data.path, data.data)
  return true
}

function readFile(data) {
  return ffmpegCore.FS.readFile(data.path, { encoding: data.encoding || "binary" })
}

function deleteFile(data) {
  ffmpegCore.FS.unlink(data.path)
  return true
}

function renameFile(data) {
  ffmpegCore.FS.rename(data.oldPath, data.newPath)
  return true
}

function createDir(data) {
  ffmpegCore.FS.mkdir(data.path)
  return true
}

function listDir(data) {
  var entries = ffmpegCore.FS.readdir(data.path)
  var result = []
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    var stat = ffmpegCore.FS.stat(data.path + "/" + entry)
    result.push({ name: entry, isDir: ffmpegCore.FS.isDir(stat.mode) })
  }
  return result
}

function deleteDir(data) {
  ffmpegCore.FS.rmdir(data.path)
  return true
}

function mount(data) {
  var fs = ffmpegCore.FS.filesystems[data.fsType]
  if (!fs) return false
  ffmpegCore.FS.mount(fs, data.options, data.mountPoint)
  return true
}

function unmount(data) {
  ffmpegCore.FS.unmount(data.mountPoint)
  return true
}

// Main message handler
self.onmessage = async function (event) {
  var id = event.data.id
  var type = event.data.type
  var data = event.data.data
  var transferList = []
  var result

  try {
    if (type !== MessageType.LOAD && !ffmpegCore) {
      throw ERRORS.NOT_LOADED
    }

    switch (type) {
      case MessageType.LOAD:
        result = await loadFFmpeg(data)
        break
      case MessageType.EXEC:
        result = executeFFmpeg(data)
        break
      case MessageType.WRITE_FILE:
        result = writeFile(data)
        break
      case MessageType.READ_FILE:
        result = readFile(data)
        break
      case MessageType.DELETE_FILE:
        result = deleteFile(data)
        break
      case MessageType.RENAME:
        result = renameFile(data)
        break
      case MessageType.CREATE_DIR:
        result = createDir(data)
        break
      case MessageType.LIST_DIR:
        result = listDir(data)
        break
      case MessageType.DELETE_DIR:
        result = deleteDir(data)
        break
      case MessageType.MOUNT:
        result = mount(data)
        break
      case MessageType.UNMOUNT:
        result = unmount(data)
        break
      default:
        throw ERRORS.UNKNOWN_MESSAGE
    }
  } catch (error) {
    console.error("[FFmpeg Worker] Error in type=" + type + ":", error, "errno:", error.errno)
    self.postMessage({ id: id, type: MessageType.ERROR, data: String(error) })
    return
  }

  if (result instanceof Uint8Array) {
    transferList.push(result.buffer)
  }

  self.postMessage({ id: id, type: type, data: result }, transferList)
}
