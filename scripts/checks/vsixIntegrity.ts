/**
 * vsix 产物完整性校验：解析 zip 中央目录并**逐条目解压比对 CRC32**（零依赖）。
 *
 * 背景（v2.3.0 实测）：打包产物曾出现「中央目录完好、中部条目本地头损坏」的静默
 * 损坏——vsce ls（文件清单）、产物体积预算、清单/入口抽检全部通过，只有把每个
 * 条目的数据解压出来比对 CRC 才能发现。打包后必须执行本检查。
 *
 * 注意：流式写入的 zip（vsce/yazl）置 flag bit 3，本地头的 CRC/size 字段为 0、
 * 真实值在数据后的 data descriptor 与中央目录中——校验一律以中央目录为准。
 * 不支持 zip64（当前产物远未触及；若出现会抛错而非漏检）。
 */
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/** zip 结构魔数：EOCD / 中央目录条目 / 本地文件头 */
const EOCD_MAGIC = 0x06054b50
const CEN_MAGIC = 0x02014b50
const LOCAL_MAGIC = 0x04034b50
/** 压缩方法：store(0) 直接比对；deflate(8) 原始解压；其余方法拒绝（防漏检） */
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
/** general purpose flag bit 3：本地头无 CRC/size，数据后跟 data descriptor */
const FLAG_DATA_DESCRIPTOR = 0x8

/** 标准表驱动 CRC-32（zip 规范；engines 的 Node 20 无 zlib.crc32，手写保证兼容） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32Of(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipVerifyResult {
  /** 中央目录条目总数 */
  total: number
  /** 校验失败的条目（空数组 = 全部通过） */
  failed: string[]
}

/**
 * 逐条目校验 zip/vsix：本地头魔数 →（按压缩方法）解压 → CRC32 比对中央目录。
 * 结构性损坏直接抛错；条目级损坏记入 failed。
 */
export function verifyZipEntries(vsixPath: string): ZipVerifyResult {
  const buf = readFileSync(vsixPath)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_MAGIC) {
      eocd = i
      break
    }
  }
  if (eocd < 0) {
    throw new Error(`${vsixPath} 不是有效的 zip（未找到 End of Central Directory）`)
  }
  const entryCount = buf.readUInt16LE(eocd + 10)
  let cursor = buf.readUInt32LE(eocd + 16)
  const failed: string[] = []
  for (let n = 0; n < entryCount; n += 1) {
    if (buf.readUInt32LE(cursor) !== CEN_MAGIC) {
      throw new Error(`${vsixPath} 中央目录第 ${n + 1} 条魔数错误（文件损坏）`)
    }
    const crcExpected = buf.readUInt32LE(cursor + 16)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen)

    if (buf.readUInt32LE(localOffset) !== LOCAL_MAGIC) {
      failed.push(`${name}（本地文件头魔数损坏）`)
    } else {
      const localFlags = buf.readUInt16LE(localOffset + 6)
      const hasDataDescriptor = (localFlags & FLAG_DATA_DESCRIPTOR) !== 0
      const localCrc = buf.readUInt32LE(localOffset + 14)
      if (!hasDataDescriptor && localCrc !== crcExpected) {
        failed.push(`${name}（本地文件头与中央目录 CRC 不一致）`)
      } else {
        const method = buf.readUInt16LE(localOffset + 8)
        const lNameLen = buf.readUInt16LE(localOffset + 26)
        const lExtraLen = buf.readUInt16LE(localOffset + 28)
        const dataStart = localOffset + 30 + lNameLen + lExtraLen
        try {
          const raw = buf.subarray(dataStart, dataStart + compressedSize)
          const data =
            method === METHOD_STORE
              ? raw
              : method === METHOD_DEFLATE
                ? inflateRawSync(raw)
                : (() => {
                    throw new Error(`不支持的压缩方法 ${method}`)
                  })()
          if (crc32Of(data) !== crcExpected) {
            failed.push(`${name}（CRC 不匹配）`)
          }
        } catch {
          failed.push(`${name}（数据解压失败）`)
        }
      }
    }
    cursor += 46 + nameLen + extraLen + commentLen
  }
  return { total: entryCount, failed }
}
