import { useEffect, useMemo, useState } from 'react'
import {
  getStrategyConfig,
  updateStrategyConfig,
  type StrategyConfig,
} from '../api/client'

interface Props {
  strategyKey: string
  onClose: () => void
}

// Humanise a snake_case config key into a label: "fast_ema" → "Fast Ema".
const labelFor = (k: string) =>
  k
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')

/**
 * StrategyEditor renders an editable form for any configurable strategy. It is
 * schema-agnostic: it fetches the strategy's current config object and renders a
 * control per field based on its JS type (boolean → toggle, number → numeric
 * input, string → text). Saving PUTs the edited object back to the backend.
 */
export default function StrategyEditor({ strategyKey, onClose }: Props) {
  const [name, setName] = useState(strategyKey)
  const [config, setConfig] = useState<StrategyConfig>({})
  const [defaults, setDefaults] = useState<StrategyConfig>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    getStrategyConfig(strategyKey)
      .then((r) => {
        if (!alive) return
        setName(r.name)
        setConfig(r.config)
        setDefaults(r.defaults)
      })
      .catch(() => alive && setError('Could not load strategy config.'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [strategyKey])

  const keys = useMemo(() => Object.keys(config), [config])

  const setField = (k: string, v: string | number | boolean) => {
    setSaved(false)
    setConfig((c) => ({ ...c, [k]: v }))
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const r = await updateStrategyConfig(strategyKey, config)
      setConfig(r.config)
      setSaved(true)
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setSaved(false)
    setConfig({ ...defaults })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[85vh] overflow-auto rounded-xl border border-slate-700 bg-dark-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">{name} · Config</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-xl leading-none"
          >
            ×
          </button>
        </div>

        {loading ? (
          <div className="py-8 text-center text-slate-400">Loading…</div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {keys.map((k) => {
                const v = config[k]
                if (typeof v === 'boolean') {
                  return (
                    <label
                      key={k}
                      className="flex items-center gap-2 rounded-lg border border-slate-700 bg-dark-800 px-3 py-2 text-sm text-slate-200"
                    >
                      <input
                        type="checkbox"
                        checked={v}
                        onChange={(e) => setField(k, e.target.checked)}
                        className="accent-brand-500"
                      />
                      {labelFor(k)}
                    </label>
                  )
                }
                if (typeof v === 'number') {
                  return (
                    <div key={k}>
                      <label className="block text-xs text-slate-400 mb-1">{labelFor(k)}</label>
                      <input
                        type="number"
                        step="any"
                        value={v}
                        onChange={(e) => setField(k, e.target.value === '' ? 0 : Number(e.target.value))}
                        className="w-full rounded-lg border border-slate-700 bg-dark-800 px-3 py-2 text-sm text-slate-200"
                      />
                    </div>
                  )
                }
                return (
                  <div key={k}>
                    <label className="block text-xs text-slate-400 mb-1">{labelFor(k)}</label>
                    <input
                      type="text"
                      value={String(v)}
                      onChange={(e) => setField(k, e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-dark-800 px-3 py-2 text-sm text-slate-200"
                    />
                  </div>
                )
              })}
            </div>

            {error && <div className="mt-3 text-sm text-red-400">{error}</div>}
            {saved && <div className="mt-3 text-sm text-emerald-400">Saved.</div>}

            <div className="mt-5 flex items-center justify-between">
              <button
                onClick={reset}
                className="text-sm text-slate-400 hover:text-white"
              >
                Reset to defaults
              </button>
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
                >
                  Close
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
