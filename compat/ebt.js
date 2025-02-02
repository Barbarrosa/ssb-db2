const EBTIndex = require('../indexes/ebt')
const { onceWhen } = require('../utils')

exports.init = function (sbot, config) {
  sbot.db.registerIndex(EBTIndex)
  if (!sbot.post) sbot.post = sbot.db.post
  const ebtIndex = sbot.db.getIndex('ebt')
  sbot.getAtSequence = ebtIndex.getMessageFromAuthorSequence.bind(ebtIndex)
  sbot.add = sbot.db.add
  sbot.getVectorClock = function (cb) {
    onceWhen(
      sbot.db2migrate && sbot.db2migrate.synchronized,
      (isSynced) => isSynced,
      () => {
        sbot.db.onDrain('base', () => {
          sbot.db.getAllLatest((err, last) => {
            if (err) return cb(err)

            const clock = {}
            for (const k in last) {
              clock[k] = last[k].sequence
            }

            cb(null, clock)
          })
        })
      }
    )
  }
}
