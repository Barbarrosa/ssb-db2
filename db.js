const push = require('push-stream')
const ssbKeys = require('ssb-keys')
const hash = require('ssb-keys/util').hash
const validate = require('ssb-validate')
const Obv = require('obz')
const promisify = require('promisify-4loc')
const jitdbOperators = require('jitdb/operators')
const operators = require('./operators')
const JITDb = require('jitdb')
const Debug = require('debug')

const { indexesPath } = require('./defaults')
const { onceWhen } = require('./utils')
const Log = require('./log')
const Status = require('./status')
const makeBaseIndex = require('./indexes/base')
const KeysIndex = require('./indexes/keys')
const PrivateIndex = require('./indexes/private')

const { and, fromDB, key, author, deferred, toCallback, asOffsets } = operators

function getId(msg) {
  return '%' + hash(JSON.stringify(msg, null, 2))
}

exports.name = 'db'

exports.version = '1.9.1'

exports.manifest = {
  get: 'async',
  add: 'async',
  publish: 'async',
  del: 'async',
  deleteFeed: 'async',
  addOOO: 'async',
  addOOOStrictOrder: 'async',
  getStatus: 'sync',

  // `query` should be `sync`, but secret-stack is automagically converting it
  // to async because of secret-stack/utils.js#hookOptionalCB. Eventually we
  // should include an option `synconly` in secret-stack that bypasses the hook,
  // but for now we leave the `query` API *implicitly* available in the plugin:

  // query: 'sync',
}

exports.init = function (sbot, config) {
  let self
  config = config || {}
  config.db2 = config.db2 || {}
  const indexes = {}
  const dir = config.path
  const privateIndex = PrivateIndex(dir, config.keys)
  const log = Log(dir, config, privateIndex)
  const jitdb = JITDb(log, indexesPath(dir))
  const status = Status(log, jitdb)
  const debug = Debug('ssb:db2')
  const post = Obv()
  const hmac_key = null
  const stateFeedsReady = Obv().set(false)
  let state = validate.initial()

  sbot.close.hook(function (fn, args) {
    close(() => {
      fn.apply(this, args)
    })
  })

  registerIndex(makeBaseIndex(privateIndex))
  registerIndex(KeysIndex)

  loadStateFeeds()

  function setStateFeedsReady(x) {
    stateFeedsReady.set(x)
  }

  function loadStateFeeds(cb) {
    // restore current state
    onDrain('base', () => {
      indexes.base.getAllLatest((err, last) => {
        // copy to so we avoid weirdness, because this object
        // tracks the state coming in to the database.
        for (const k in last) {
          state.feeds[k] = {
            id: last[k].id,
            timestamp: last[k].timestamp,
            sequence: last[k].sequence,
            queue: [],
          }
        }
        debug('getAllLatest is done setting up initial validate state')
        if (!stateFeedsReady.value) stateFeedsReady.set(true)
        if (cb) cb()
      })
    })
  }

  // Crunch stats numbers to produce one number for the "indexing" progress
  status.obv((stats) => {
    const logSize = Math.max(1, stats.log) // 1 prevents division by zero
    const nums = Object.values(stats.indexes).concat(Object.values(stats.jit))
    const N = Math.max(1, nums.length) // 1 prevents division by zero
    const progress = Math.min(
      nums
        .map((offset) => Math.max(0, offset)) // avoid -1 numbers
        .map((offset) => offset / logSize) // this index's progress
        .reduce((acc, x) => acc + x, 0) / N, // avg = (sum of all progress) / N
      1 // never go above 1
    )
    sbot.emit('ssb:db2:indexing:progress', progress)
  })

  function guardAgainstDuplicateLogs(methodName) {
    if (sbot.db2migrate && sbot.db2migrate.doesOldLogExist()) {
      return new Error(
        'ssb-db2: refusing to ' +
          methodName +
          ' because the old log still exists. ' +
          'This is to protect your feed from forking ' +
          'into an irrecoverable state.'
      )
    }
  }

  function getHelper(id, onlyValue, cb) {
    self.query(
      and(key(id)),
      toCallback((err, results) => {
        if (err) return cb(err)
        else if (results.length)
          return cb(null, onlyValue ? results[0].value : results[0])
        else return cb(new Error('Key not found in database ' + id))
      })
    )
  }

  function get(id, cb) {
    getHelper(id, true, cb)
  }

  function getMsg(id, cb) {
    getHelper(id, false, cb)
  }

  function rawAdd(msg, validated, cb) {
    const id = getId(msg)
    if (validated)
      // ssb-validate makes sure things come in order
      log.add(id, msg, cb)
    else
      get(id, (err, data) => {
        if (data) cb(null, data)
        else log.add(id, msg, cb)
      })
  }

  function add(msg, cb) {
    const guard = guardAgainstDuplicateLogs('add()')
    if (guard) return cb(guard)

    onceWhen(
      stateFeedsReady,
      (ready) => ready === true,
      () => {
        try {
          state = validate.append(state, hmac_key, msg)
          if (state.error) return cb(state.error)
          rawAdd(msg, true, cb)
        } catch (ex) {
          return cb(ex)
        }
      }
    )
  }

  function addOOO(msg, cb) {
    const guard = guardAgainstDuplicateLogs('addOOO()')
    if (guard) return cb(guard)

    try {
      let oooState = validate.initial()
      validate.appendOOO(oooState, hmac_key, msg)

      if (oooState.error) return cb(oooState.error)

      rawAdd(msg, false, cb)
    } catch (ex) {
      return cb(ex)
    }
  }

  function addOOOStrictOrder(msg, strictOrderState, cb) {
    const guard = guardAgainstDuplicateLogs('addOOOStrictOrder()')
    if (guard) return cb(guard)

    const knownAuthor = msg.author in strictOrderState.feeds

    try {
      if (!knownAuthor)
        strictOrderState = validate.appendOOO(strictOrderState, hmac_key, msg)
      else strictOrderState = validate.append(strictOrderState, hmac_key, msg)

      if (strictOrderState.error) return cb(strictOrderState.error)

      rawAdd(msg, true, cb)
    } catch (ex) {
      return cb(ex)
    }
  }

  function publish(msg, cb) {
    const guard = guardAgainstDuplicateLogs('publish()')
    if (guard) return cb(guard)

    onceWhen(
      stateFeedsReady,
      (ready) => ready === true,
      () => {
        if (msg.recps) msg = ssbKeys.box(msg, msg.recps)

        state.queue = []
        state = validate.appendNew(state, null, config.keys, msg, Date.now())

        rawAdd(state.queue[0].value, true, (err, data) => {
          post.set(data)
          cb(err, data)
        })
      }
    )
  }

  function del(msgId, cb) {
    const guard = guardAgainstDuplicateLogs('del()')
    if (guard) return cb(guard)

    self.query(
      and(key(msgId)),
      asOffsets(),
      toCallback((err, results) => {
        if (err) return cb(err)
        if (results.length === 0)
          return cb(
            new Error('cannot delete ' + msgId + ' because it was not found')
          )

        indexes['keys'].delMsg(msgId)
        log.del(results[0], cb)
      })
    )
  }

  function deleteFeed(feedId, cb) {
    const guard = guardAgainstDuplicateLogs('deleteFeed()')
    if (guard) return cb(guard)

    jitdb.all(author(feedId), 0, false, true, (err, offsets) => {
      push(
        push.values(offsets),
        push.asyncMap((offset, cb) => {
          log.del(offset, cb)
        }),
        push.collect((err) => {
          if (err) cb(err)
          else {
            delete state.feeds[feedId]
            indexes.base.removeFeedFromLatest(feedId, cb)
          }
        })
      )
    })
  }

  function clearIndexes() {
    for (const indexName in indexes) indexes[indexName].remove(() => {})
  }

  function registerIndex(Index) {
    const index = new Index(log, dir)

    if (indexes[index.name]) throw 'Index already exists'

    index.offset((o) => status.updateIndex(index.name, o))

    indexes[index.name] = index
  }

  function updateIndexes() {
    const start = Date.now()

    const indexesArr = Object.values(indexes)

    const lowestOffset = Math.min(...indexesArr.map((idx) => idx.offset.value))
    debug(`lowest offset for all indexes is ${lowestOffset}`)

    log.stream({ gt: lowestOffset }).pipe({
      paused: false,
      write(record) {
        indexesArr.forEach((idx) => idx.onRecord(record, false))
      },
      end() {
        debug(`updateIndexes() scan time: ${Date.now() - start}ms`)
        const writeTasks = indexesArr.map((idx) =>
          promisify(idx.flush.bind(idx))()
        )
        Promise.all(writeTasks).then(() => {
          debug('updateIndexes() live streaming')
          log.stream({ gt: indexes['base'].offset.value, live: true }).pipe({
            paused: false,
            write(record) {
              indexesArr.forEach((idx) => idx.onRecord(record, true))
            },
          })
        })
      },
    })
  }

  function onDrain(indexName, cb) {
    if (!cb) {
      // default
      cb = indexName
      indexName = 'base'
    }

    // setTimeout to make sure extra indexes from secret-stack are also included
    setTimeout(() => {
      onIndexesStateLoaded(() => {
        log.onDrain(() => {
          const index = indexes[indexName]
          if (!index) return cb('Unknown index:' + indexName)

          status.updateLog()

          if (index.offset.value === log.since.value) {
            status.updateIndex(indexName, index.offset.value)
            cb()
          } else {
            const remove = index.offset(() => {
              if (index.offset.value === log.since.value) {
                remove()
                status.updateIndex(indexName, index.offset.value)
                cb()
              }
            })
          }
        })
      })
    })
  }

  function onIndexesStateLoaded(cb) {
    if (!onIndexesStateLoaded.promise) {
      const stateLoadedPromises = [privateIndex.stateLoaded]
      for (const indexName in indexes) {
        stateLoadedPromises.push(indexes[indexName].stateLoaded)
      }
      onIndexesStateLoaded.promise = Promise.all(stateLoadedPromises)
    }
    onIndexesStateLoaded.promise.then(cb)
  }

  // setTimeout to make sure extra indexes from secret-stack are also included
  const timer = setTimeout(() => {
    onIndexesStateLoaded(updateIndexes)
  })
  if (timer.unref) timer.unref()

  function close(cb) {
    const tasks = []
    for (const indexName in indexes) {
      const index = indexes[indexName]
      tasks.push(promisify(index.close.bind(index))())
    }
    return Promise.all(tasks)
      .then(() => promisify(log.close)())
      .then(cb)
  }

  // override query() from jitdb to implicitly call fromDB()
  function query(first, ...rest) {
    // Before running the query, the log needs to be migrated/synced with the
    // old log and it should be 'drained'
    const waitUntilReady = deferred((meta, cb) => {
      if (sbot.db2migrate) {
        sbot.db2migrate.synchronized((isSynced) => {
          if (isSynced) log.onDrain(cb)
        })
      } else {
        log.onDrain(cb)
      }
    })

    if (rest.length === 0) {
      const ops = fromDB(jitdb)
      ops.meta.db = this
      return jitdbOperators.query(ops, and(waitUntilReady), first)
    }

    if (!first.meta) {
      const ops = fromDB(jitdb)
      ops.meta.db = this
      return jitdbOperators.query(ops, and(waitUntilReady, first), ...rest)
    } else {
      return jitdbOperators.query(first, and(waitUntilReady), ...rest)
    }
  }

  return (self = {
    // API:
    get,
    getMsg,
    query,
    del,
    deleteFeed,
    add,
    publish,
    addOOO,
    addOOOStrictOrder,
    getStatus: () => status.obv,
    operators,

    // needed primarily internally by other plugins in this project:
    post,
    getLatest: indexes.base.getLatest.bind(indexes.base),
    getAllLatest: indexes.base.getAllLatest.bind(indexes.base),
    getLog: () => log,
    registerIndex,
    setStateFeedsReady,
    loadStateFeeds,
    getIndexes: () => indexes,
    getIndex: (index) => indexes[index],
    clearIndexes,
    onDrain,
    getJITDB: () => jitdb,
  })
}
