const bounds = require('binary-search-bounds')
const Long = require('long')

class MultiValue {
  constructor (...values) {
    this.values = values
  }
}

// Extract the common key prefix from an array of values
function commonPrefix (arr, options) {
  if (arr.length === 0) {
    return options.emptyPrefix
  } else if (arr.length === 1) {
    return options.getKey(arr[0])
  }
  const first = options.getKey(arr[0])
  const last = options.getKey(arr[arr.length - 1])
  const n = options.match(first, last)
  return options.prefix(first, n)
}

function assign (newVal, oldVal, options) {
  if (options.uniqueKeys || oldVal === undefined) {
    return newVal
  } else if (oldVal instanceof MultiValue) {
    oldVal.values.push(newVal)
    return oldVal
  }
  let mv = new MultiValue(oldVal, newVal)
  mv = options.setKey(mv, options.getKey(newVal))
  return mv
}

function coerceArray (arr) {
  const n = arr.length
  return (n === 0) ? undefined : ((n === 1) ? arr[0] : arr)
}

const find = (node, key, options, cb) => {
  let prev = null
  while (true) {
    const n = options.match(key, node.skip)

    // If no prefix match, then return
    if (n !== node.skip.length) {
      return cb(node, prev, false)
    }

    // If this is a terminal node, stop
    if (!node.edges) {
      return cb(node, prev, true)
    }

    // If the internal value matches this key, stop
    if (n === key.length) {
      return cb(node, prev, true)
    }

    // Traverse the jump table
    const x = key.charAt(node.skip.length)
    const child = node.edges[x]
    if (!child) {
      return cb(node, prev, false)
    }
    prev = node
    node = child
  }
}

class Node {
  // Values must be sorted by key
  constructor (values, options) {
    this.skip = commonPrefix(values, options)
    this.edges = undefined
    this.values = values
    this.dirty = false
    this._explode(options)
  }

  // Add a value
  add (key, value, options) {
    // If this is a terminal node, simply add the value
    if (!this.edges) {
      this._insert(key, value, options)
      this._explode(options)
      return
    }

    // Check if we have a prefix match
    const n = options.match(key, this.skip)
    if (n === this.skip.length) {
      if (n === key.length) {
        // Value belongs on this node
        this.values = assign(value, this.values, options)
        return
      }

      // Traverse the jump table
      const x = key.charAt(this.skip.length)
      const node = this.edges[x]
      if (node) {
        node.add(key, value, options)
      } else {
        this.edges[x] = new Node([value], options)
      }
      return
    }

    // It is necessary to split this node apart, start by splitting skip
    const prefix = options.prefix(this.skip, n)
    const cx = this.skip.charAt(prefix.length)

    // Create the new child node, which will inherit everything on this node
    const child = new Node([], options)
    child.skip = this.skip
    child.edges = this.edges
    child.values = this.values
    this.skip = prefix
    this.edges = []
    this.edges[cx] = child
    this.values = undefined

    // Now we can call add on this node again
    this.add(key, value, options)
  }

  // Insert value into a terminal node's bin of values
  _insert (key, value, options) {
    // Update skip value
    const n = options.match(key, this.skip)
    if (n !== this.skip.length) {
      this.skip = options.prefix(this.skip, n)
    }

    // Update dirty flag
    const count = this.values.length
    if (count && options.comparator(this.values[count - 1], value) >= 0) {
      this.dirty = true
    }
    this.values.push(value)
  }

  // Search for a value by it's key
  get (key, options) {
    return find(this, key, options, (node, parent, matched) => {
      if (!matched) {
        return undefined
      } else if (node.edges) {
        return node.values // Match was on internal value
      } else {
        return node._search(key, options) // Binary search the values list
      }
    })
  }

  // Binary search a terminal node's values list for a key
  _search (key, options) {
    this._sortValues(options)
    const needle = options.setKey({}, key)  // Create a dummy value for searching
    const idx = bounds.eq(this.values, needle, options.comparator)
    return (idx < 0) ? undefined : this.values[idx]
  }

  _sortValues (options) {
    if (this.dirty) {
      const arr = this.values
      arr.sort(options.comparator)
      this.dirty = false

      // Collapse multiple values with same key into a single value
      const n = arr.length
      if (n > 1) {
        let i = 0
        for (let j = 1; j < n; j++) {
          if (options.comparator(arr[i], arr[j]) === 0) {
            arr[i] = assign(arr[j], arr[i], options)
          } else {
            i++
            arr[i] = arr[j]
          }
        }
        arr.splice(i + 1)
      }
    }
  }

  // Remove a value from the trie by key
  delete (key, options, filter) {
    // If no prefix match, then return
    const n = options.match(key, this.skip)
    if (n !== this.skip.length) {
      return undefined
    }

    // If this is a terminal node, binary search for the key
    if (!this.edges) {
      this._sortValues(options)
      const needle = options.setKey({}, key)  // Create a dummy value for searching
      const idx = bounds.eq(this.values, needle, options.comparator)
      if (idx >= 0) {
        const [ keep, removed ] = this._delete(this.values[idx], filter)
        if (keep === undefined) {
          this.values.splice(idx, 1)
        }
        return removed
      }
      return undefined
    }

    // Check if the internal value matches this key
    if (n === key.length) {
      const [ keep, removed ] = this._delete(this.values, filter)
      this.values = keep
      return removed
    }

    // Traverse the jump table
    const x = key.charAt(this.skip.length)
    const child = this.edges[x]
    if (child) {
      // Call delete recursively
      const ret = child.delete(key, options, filter)
      if (ret !== undefined) {
        this._compact(x, child) // Compact if we actually removed something
      }
      return ret
    }
    return undefined
  }

  _delete (val, filter) {
    // Handle multi-value case first
    if (val instanceof MultiValue) {
      let keep = []
      let removed = []
      val.values.forEach(x => {
        if (filter === undefined || filter(x)) {
          removed.push(x)
        } else {
          keep.push(x)
        }
      })
      val.values = keep
      keep = (keep.length > 1) ? val : coerceArray(keep)
      removed = coerceArray(removed)
      return [keep, removed]
    }

    // Handle simple value case
    if (filter === undefined || filter(val)) {
      return [undefined, val]
    } else {
      return [val, undefined]
    }
  }

  _compact (path, child) {
    // Check if child is an empty terminal node
    if (!child.edges && !child.values.length) {
      delete this.edges[path]

      // Count how many edges we have left
      let edgeCount = 0
      for (const node of this.edges) {
        child = node
        edgeCount++
      }

      // Try to compact this node
      if (edgeCount === 0) {
        // No edges left, convert back to terminal node
        this.edges = undefined
        this.values = this.values ? [this.values] : []
        this.dirty = false
      } else if (edgeCount === 1 && this.values === undefined) {
        // Single edge and no internal value, redundant node
        this.skip = child.skip
        this.edges = child.edges
        this.values = child.values
        this.dirty = child.dirty
      }
    }
  }

  // Convert from a terminal node to node with branches
  _explode (options) {
    // Check if we're big enough
    if (this.values.length <= options.binSize) {
      return
    }

    // Make sure values are sorted, and combine duplicate keys
    this._sortValues(options)

    // Are we still big enough?
    if (this.values.length <= options.binSize) {
      return
    }

    // Update internal state
    const values = this.values
    this.skip = commonPrefix(values, options)
    this.edges = []
    this.values = undefined
    const prefixLen = this.skip.length

    // For each value, get it's corresponding character in the jump table
    const nextChars = values.map(v => {
      const k = options.getKey(v)
      return k.length === prefixLen ? undefined : k.charAt(prefixLen)
    })
    const count = nextChars.length

    // Set internal value (exact key match), if one exists
    let i = 0
    if (nextChars[0] === undefined) {
      this.values = values[0]
      i++
    }

    // Populate edges
    while (i < count) {
      const x = nextChars[i]
      let j = i + 1
      while (j < count) {
        if (x !== nextChars[j]) {
          break
        }
        j++
      }

      // Populate edge
      this.edges[x] = new Node(values.slice(i, j), options)
      i = j
    }
  }
}

const DEFAULT_OPTS = {
  uniqueKeys: true,
  binSize: 256
}

function cmp (a, b) {
  if (a === b) {
    return 8
  }

  let n = 0
  if ((a & 0xFFFF0000) === (b & 0xFFFF0000)) {
    n += 4
  } else {
    a = a >> 16
    b = b >> 16
  }

  if ((a & 0xFF00) === (b & 0xFF00)) {
    n += 2
  } else {
    a = a >> 8
    b = b >> 8
  }

  if ((a & 0xF0) === (b & 0xF0)) {
    n++
  }

  return n
}

class NumericKey {
  constructor (num, length = 16) {
    this.value = Long.fromNumber(num)
    this.length = length
  }

  charAt (pos) {
    let y = 64 - (pos + 1) * 4
    return this.value.shr_u(y).low & 0xF
  }

  match (other) {
    const a = this.value
    const b = other.value
    if (this.length === other.length && a.high === b.high && a.low === b.low) {
      return this.length
    }
    let n = Math.min(this.length, other.length)
    if (n > 0) {
      if (a.high === b.high) {
        n = Math.min(n, cmp(a.low, b.low) + 8)
      } else {
        n = Math.min(n, cmp(a.high, b.high))
      }
    }
    return n
  }

  prefix (n) {
    let y = 64 - (n * 4)
    let num = this.value.shr_u(y).shl(y).toNumber()
    return new NumericKey(num, n)
  }

  toNumber () {
    return this.value.toNumber()
  }
}

const KEY_TYPES = {
  string: {
    createKey: (opts) => {
      return x => x
    },
    getKey: (opts) => {
      if (opts.attr) {
        return x => x[opts.attr]
      } else {
        return x => (x instanceof MultiValue) ? x.key : x
      }
    },
    setKey: (opts) => {
      if (opts.attr) {
        return (value, key) => { value[opts.attr] = key; return value }
      } else {
        return (value, key) => {
          if (value instanceof MultiValue) {
            value.key = key
            return value
          } else {
            return key
          }
        }
      }
    },
    comparator: (opts) => {
      if (opts.attr) {
        return (a, b) => {
          a = a[opts.attr]
          b = b[opts.attr]
          return a < b ? -1 : (a > b ? 1 : 0)
        }
      } else {
        return (a, b) => {
          a = (a instanceof MultiValue) ? a.key : a
          b = (b instanceof MultiValue) ? b.key : b
          return (a, b) => a < b ? -1 : (a > b ? 1 : 0)
        }
      }
    },
    match: (opts) => {
      return (a, b) => {
        let i = 0
        const n = Math.min(a.length, b.length)
        while (i < n && a[i] === b[i]) {
          i++
        }
        return i
      }
    },
    prefix: (opts) => {
      return (key, n) => key.substr(0, n)
    },
    emptyPrefix: ''
  },
  number: {
    createKey: (opts) => {
      return x => new NumericKey(x)
    },
    getKey: (opts) => {
      if (opts.attr) {
        return x => new NumericKey(x[opts.attr])
      } else {
        return x => new NumericKey((x instanceof MultiValue) ? x.key : x)
      }
    },
    setKey: (opts) => {
      if (opts.attr) {
        return (value, key) => { value[opts.attr] = key.toNumber(); return value }
      } else {
        return (value, key) => {
          key = key.value()
          if (value instanceof MultiValue) {
            value.key = key
            return value
          } else {
            return key
          }
        }
      }
    },
    comparator: (opts) => {
      if (opts.attr) {
        return (a, b) => a[opts.attr] - b[opts.attr]
      } else {
        return (a, b) => a - b
      }
    },
    match: (opts) => {
      return (a, b) => a.match(b)
    },
    prefix: (opts) => {
      return (key, n) => key.prefix(n)
    },
    emptyPrefix: new NumericKey(0, 0)
  }
}

class Trie {
  constructor (options = {}) {
    // Construct type options
    const { type } = {type: 'string', ...options}
    let typeOpts = KEY_TYPES[type]
    if (typeOpts) {
      typeOpts = {
        createKey: typeOpts.createKey(options),
        getKey: typeOpts.getKey(options),
        setKey: typeOpts.setKey(options),
        comparator: typeOpts.comparator(options),
        match: typeOpts.match(options),
        prefix: typeOpts.prefix(options),
        emptyPrefix: typeOpts.emptyPrefix
      }
    }

    this.options = {...DEFAULT_OPTS, ...typeOpts, ...options}
    this.root = new Node([], this.options)
  }

  add (value) {
    const { root, options } = this
    return root.add(options.getKey(value), value, options)
  }

  get (key, filter = undefined) {
    const { root, options } = this
    let ret = root.get(options.createKey(key), options)

    // Coerce MultiValue's into array, and apply filter (if supplied)
    if (ret instanceof MultiValue) {
      ret = ret.values
      if (filter) {
        ret = ret.filter(x => filter(x))
      }
      return coerceArray(ret)
    } else {
      return (filter === undefined || filter(ret)) ? ret : undefined
    }
  }

  delete (key, filter = undefined) {
    const { root, options } = this
    const ret = root.delete(options.createKey(key), options, filter)
    if (!root.edges && !root.values.length) {
      root.skip = options.emptyPrefix  // Root node needs to be reset if empty
    }
    return ret
  }
}

module.exports = Trie
