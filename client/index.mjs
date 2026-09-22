/** Self-contained factory: the build embeds it without bundling another React. */
export function createClientPlugin(require) {
  const React = require('react');
  const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;
  const namespace = 'dsh-rpm';
  const inject = ['slots', 'settingsScope'];

  /**
   * Per-card "Rate limit (requests per minute)" row. Backs onto the durable
   * `dsh-rpm` settings document: providers[route] = rpm; absent = unlimited.
   */
  function RpmRow({ provider, scope }) {
    const reader = useMemo(() => ({
      subscribe: listener => scope.subscribe(listener),
      getSnapshot: () => scope.getSnapshot(),
    }), [scope]);
    const snapshot = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
    const [draft, setDraft] = useState('');
    const [dirty, setDirty] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const busy = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; };
    }, []);

    const route = provider.provider;
    const saved = snapshot.value?.providers?.[route];
    const writable = snapshot.status === 'ready' && snapshot.writable && snapshot.mode === 'host';

    // Follow external changes (another card of the same provider, reloads).
    useEffect(() => {
      setDraft('');
      setDirty(false);
    }, [saved, snapshot.revision, route]);

    // Untouched fields track the persisted value; edits stay until saved.
    const display = dirty ? draft : (typeof saved === 'number' ? String(saved) : '');

    async function save() {
      if (!writable || busy.current) return;
      const trimmed = display.trim();
      const next = trimmed === '' ? 0 : Number(trimmed);
      if (!Number.isInteger(next) || next < 0) {
        setError('Enter 0 (unlimited) or a positive whole number.');
        return;
      }
      busy.current = true;
      setPending(true);
      setError('');
      try {
        // Fence the rendered snapshot; the scope owns serialization, recovery,
        // and the shared mirror that refreshes every occurrence of this card.
        await scope.mutate([next === 0
          ? { op: 'unset', path: ['providers', route] }
          : { op: 'set', path: ['providers', route], value: next }], snapshot.revision);
        // This installed scope recovers {ok:false} responses without rejecting.
        // Confirm the mirrored value instead of treating settlement as success.
        const settled = scope.getSnapshot();
        const settledValue = settled.value?.providers?.[route] ?? 0;
        if (settled.status !== 'ready' || settledValue !== next) {
          throw new Error('Setting was not confirmed');
        }
        if (mounted.current) setDirty(false);
      } catch {
        // Never render raw transport errors: only this namespace is relevant,
        // and server diagnostics can contain configuration details.
        if (mounted.current) setError('Could not save this setting. It may have changed elsewhere. Review the current value and try again.');
      } finally {
        busy.current = false;
        if (mounted.current) setPending(false);
      }
    }

    return h('div', { style: { padding: '12px 0', fontSize: '13px' } },
      h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
        h('span', null, 'Rate limit (requests per minute)'),
        h('input', {
          type: 'number', min: 0, step: 1, placeholder: 'unlimited',
          value: display, disabled: !writable || pending,
          onChange: event => { setDraft(event.currentTarget.value); setDirty(true); },
          'aria-label': `Requests-per-minute limit for ${route}`,
          'aria-busy': pending,
          style: {
            width: '110px', padding: '4px 8px', boxSizing: 'border-box',
            border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '6px',
            background: 'transparent', color: 'inherit', font: 'inherit',
          },
        }),
        h('button', {
          type: 'button', disabled: !writable || pending,
          onClick: save,
          style: {
            padding: '4px 12px', border: '1px solid var(--dsw-alias-border-l3)',
            borderRadius: '6px', background: 'transparent', color: 'inherit',
            font: 'inherit', cursor: 'pointer',
          },
        }, 'Apply')),
      h('p', { style: { margin: '6px 0 0', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px', maxWidth: '520px' } },
        'Requests beyond the limit are delayed until the next one-minute window instead of failing. 0 or empty = unlimited. Applies to every session immediately.'),
      snapshot.status === 'loading' ? h('p', { role: 'status', style: { margin: '6px 0 0' } }, 'Loading setting…') : null,
      !writable && snapshot.status !== 'loading' ? h('p', { role: 'status', style: { margin: '6px 0 0' } }, 'This setting is unavailable or read-only.') : null,
      pending ? h('p', { role: 'status', style: { margin: '6px 0 0' } }, 'Saving…') : null,
      error ? h('p', { role: 'alert', style: { margin: '6px 0 0' } }, error) : null);
  }

  function apply(ctx) {
    // bind() belongs to this calling fiber; it owns subscription/write teardown.
    const scope = ctx.settingsScope.bind({ namespace });
    // The llm-pi-ai card cell belongs to dsh-short-tool-ids; when that plugin
    // is installed it renders this same RpmRow beneath its own toggle. Here we
    // cover the remaining provider-card cells (DeepSeek official).
    ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
      name: 'settings.models.provider-card',
      key: 'llm-deepseek',
      inject: () => ({ scope }),
    }, RpmRow));
  }

  return { inject, apply, RpmRow };
}
