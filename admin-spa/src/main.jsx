import React from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider, Page, Card, Text, BlockStack, TextField, Select, Button, FormLayout, InlineStack, Tabs, Banner, IndexTable, Badge, Spinner, Modal, Checkbox, Frame, Toast, Pagination, useIndexResourceState, EmptyState, SkeletonDisplayText, SkeletonBodyText, Tooltip } from '@shopify/polaris'
import '@shopify/polaris/build/esm/styles.css'

function useAppBridgeConfig() {
  const [config, setConfig] = React.useState(null)
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const host = params.get('host') || ''
    fetch('/shopify/config', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setConfig({ apiKey: data.apiKey, host, forceRedirect: true }))
      .catch(() => setConfig({ apiKey: '', host }))
  }, [])
  return config
}

function RulesTable({ onToast }) {
  const [loading, setLoading] = React.useState(true)
  const [rows, setRows] = React.useState([])
  const [err, setErr] = React.useState(null)
  const [msg, setMsg] = React.useState(null)
  const [lastLoaded, setLastLoaded] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [bulkScope, setBulkScope] = React.useState('page') // 'page' | 'filtered'
  const [qInput, setQInput] = React.useState('')

  // Edit modal state
  const [edit, setEdit] = React.useState(null) // { id, name, status, priority, limit, ab }
  const [savingEdit, setSavingEdit] = React.useState(false)

  // Import file input ref
  const fileRef = React.useRef(null)

  // Filters / sorting / pagination
  const [q, setQ] = React.useState('')
  const [fStatus, setFStatus] = React.useState('all') // all|active|inactive
  const [fPlacement, setFPlacement] = React.useState('all') // all|product_page|cart
  const [sortKey, setSortKey] = React.useState('id') // id|name|prio|impr|rate|revenue
  const [sortDir, setSortDir] = React.useState('desc') // asc|desc
  const [page, setPage] = React.useState(1)
  const [perPage, setPerPage] = React.useState(10)

  // Filters helper
  const anyFilter = !!(q.trim() || (fStatus !== 'all') || (fPlacement !== 'all'))
  const clearFilters = React.useCallback(() => {
    setQ('')
    setQInput('')
    setFStatus('all')
    setFPlacement('all')
    setSortKey('id')
    setSortDir('desc')
    setPage(1)
  }, [])

  // Persist table UI state (filters/sort/pagination)
  React.useEffect(() => {
    try {
      const s = localStorage.getItem('rulesTableState')
      if (s) {
        const saved = JSON.parse(s)
        if (typeof saved.q === 'string') { setQ(saved.q); setQInput(saved.q) }
        if (typeof saved.fStatus === 'string') setFStatus(saved.fStatus)
        if (typeof saved.fPlacement === 'string') setFPlacement(saved.fPlacement)
        if (typeof saved.sortKey === 'string') setSortKey(saved.sortKey)
        if (typeof saved.sortDir === 'string') setSortDir(saved.sortDir)
        if (saved.perPage) setPerPage(parseInt(saved.perPage) || 10)
        if (saved.page) setPage(parseInt(saved.page) || 1)
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounce search input
  React.useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 300)
    return () => clearTimeout(t)
  }, [qInput])

  React.useEffect(() => {
    try {
      localStorage.setItem('rulesTableState', JSON.stringify({ q, fStatus, fPlacement, sortKey, sortDir, perPage, page }))
    } catch {}
  }, [q, fStatus, fPlacement, sortKey, sortDir, perPage, page])

  const load = React.useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [rRules, rAn] = await Promise.all([
        fetch('/api/rules', { credentials: 'include' }),
        fetch('/api/analytics/by-rule', { credentials: 'include' }),
      ])
      const jRules = await rRules.json()
      const jAn = await rAn.json()
      const metrics = (jAn && jAn.rules) || {}
      const mapped = (jRules.rules || []).map((r) => {
        const m = metrics[r.id] || {}
        return {
          id: String(r.id), // string id for IndexTable/useIndexResourceState
          rid: r.id,        // numeric id for sorting/display
          name: r.name,
          placement: r.placement,
          status: r.status,
          priority: r.priority,
          limit: r.limit_count,
          ab: r.ab_test_pct,
          impr: m.impression || 0,
          ctrl: m.control_impression || 0,
          acc: m.accept || 0,
          rate: m.rate || 0,
          revenue: m.revenue || 0,
          discount: m.discount || 0,
        }
      })
      setRows(mapped)
      setLastLoaded(Date.now())
    } catch (e) {
      setErr(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  // Refresh when rules are changed elsewhere (e.g., import)
  React.useEffect(() => {
    const h = () => load()
    window.addEventListener('rules:changed', h)
    return () => window.removeEventListener('rules:changed', h)
  }, [load])

  // Formatters and derived values
  

  const onDelete = async (id) => {
    if (!confirm('Delete this rule?')) return
    try {
      const r = await fetch(`/api/rules/${id}`, { method: 'DELETE', credentials: 'include' })
      const j = await r.json().catch(()=>({}))
      if (!r.ok || j.error) throw new Error(j.error || 'Failed to delete rule')
      if (onToast) onToast('Rule deleted')
      load()
    } catch (e) {
      setErr(e?.message || String(e))
    }
  }

  const copyFilteredIds = async () => {
    try {
      await navigator.clipboard.writeText(filtered.map(r=>r.id).join(','))
      if (onToast) onToast('Copied filtered IDs')
    } catch (e) {
      setErr('Failed to copy IDs')
    }
  }

  const onToggleStatus = async (r) => {
    const newStatus = r.status === 'active' ? 'inactive' : 'active'
    try {
      const resp = await fetch(`/api/rules/${r.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: newStatus }) })
      const j = await resp.json().catch(()=>({}))
      if (!resp.ok || j.error) throw new Error(j.error || 'Failed to update status')
      if (onToast) onToast(`Rule ${newStatus}`)
      load()
    } catch (e) {
      setErr(e?.message || String(e))
    }
  }

  const openEdit = (r) => {
    setEdit({ id: r.id, name: r.name, status: r.status, priority: String(r.priority), limit: String(r.limit), ab: String(r.ab) })
  }

  const saveEdit = async () => {
    if (!edit) return
    setSavingEdit(true); setErr(null)
    try {
      const payload = {
        name: edit.name || '',
        status: edit.status || 'active',
        priority: parseInt(edit.priority||'0'),
        limit: parseInt(edit.limit||'0'),
        ab_test_pct: parseInt(edit.ab||'0'),
      }
      const resp = await fetch(`/api/rules/${edit.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) })
      const j = await resp.json().catch(()=>({}))
      if (!resp.ok || j.error) throw new Error(j.error || 'Failed to save changes')
      setEdit(null)
      if (onToast) onToast('Rule updated')
      load()
    } catch (e) {
      setErr(e?.message || String(e))
    } finally {
      setSavingEdit(false)
    }
  }

  const onExport = async () => {
    try {
      const r = await fetch('/api/rules/export', { credentials: 'include' })
      const j = await r.json()
      const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'boopug_rules_export.json'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(e?.message || String(e))
    }
  }

  const onExportFiltered = async () => {
    try {
      const data = filtered.map(({ rid, id, name, placement, status, priority, limit, ab, impr, acc, rate, revenue, discount }) => ({ rid, id, name, placement, status, priority, limit, ab, impr, acc, rate, revenue, discount }))
      const blob = new Blob([JSON.stringify({ items: data }, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'boopug_rules_filtered.json'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(e?.message || String(e))
    }
  }

  const onImportClick = () => { try { fileRef.current?.click() } catch(_){} }
  const onImportFile = async (ev) => {
    try {
      const file = ev?.target?.files?.[0]
      if (!file) return
      const txt = await file.text()
      let data
      try { data = JSON.parse(txt) } catch (e) { throw new Error('Invalid JSON file') }
      const replace = confirm('Replace ALL existing rules?\nOK = replace, Cancel = append')
      const r = await fetch(`/api/rules/import?replace=${replace?'true':'false'}` , { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(data) })
      const j = await r.json()
      if (!r.ok || j.error) throw new Error(j.error || 'Import failed')
      setMsg({ tone: 'success', text: 'Import complete' })
      try { window.dispatchEvent(new CustomEvent('rules:changed')) } catch(_){}
    } catch (e) {
      setErr(e?.message || String(e))
    } finally {
      try { if (fileRef.current) fileRef.current.value = '' } catch(_){}
    }
  }

  // Derived rows (filter, sort, paginate)
  const filtered = React.useMemo(() => {
    let list = rows
    if (q.trim()) {
      const s = q.trim().toLowerCase()
      list = list.filter(r => String(r.id).includes(s) || (r.name||'').toLowerCase().includes(s))
    }
    if (fStatus !== 'all') list = list.filter(r => r.status === fStatus)
    if (fPlacement !== 'all') list = list.filter(r => r.placement === fPlacement)
    return list
  }, [rows, q, fStatus, fPlacement])

  const sorted = React.useMemo(() => {
    const l = [...filtered]
    const dir = sortDir === 'asc' ? 1 : -1
    l.sort((a,b) => {
      const by = (k) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0)
      switch (sortKey) {
        case 'name': return by('name') * dir
        case 'prio': return by('priority') * dir
        case 'impr': return by('impr') * dir
        case 'rate': return by('rate') * dir
        case 'revenue': return by('revenue') * dir
        default: return by('rid') * dir
      }
    })
    return l
  }, [filtered, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage))
  const currentPage = Math.min(page, totalPages)
  const start = (currentPage - 1) * perPage
  const paginated = sorted.slice(start, start + perPage)
  const totalCount = filtered.length
  const end = Math.min(start + paginated.length, totalCount)
  const totalAll = rows.length
  const totalActive = rows.filter(r => r.status === 'active').length
  const totalInactive = totalAll - totalActive

  const nf2 = React.useMemo(() => new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), [])
  const nf0 = React.useMemo(() => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }), [])

  const totals = React.useMemo(() => {
    const t = { impr: 0, acc: 0, revenue: 0, discount: 0, rate: 0 }
    for (const r of filtered) { t.impr += r.impr||0; t.acc += r.acc||0; t.revenue += r.revenue||0; t.discount += r.discount||0 }
    t.rate = t.impr ? (t.acc / t.impr) : 0
    return t
  }, [filtered])

  const resourceName = { singular: 'rule', plural: 'rules' }
  const {selectedResources, allResourcesSelected, handleSelectionChange, clearSelection} = useIndexResourceState(paginated)

  const hasSelection = !!allResourcesSelected || (Array.isArray(selectedResources) && selectedResources.length > 0)
  const disableRowActions = !!allResourcesSelected

  const bulkDelete = async () => {
    const ids = bulkScope === 'filtered' ? filtered.map(r=>r.id) : (allResourcesSelected ? paginated.map(r=>r.id) : selectedResources)
    if (!ids.length) return
    if (!confirm(`Delete ${ids.length} selected rule(s)?`)) return
    try {
      setBusy(true)
      const results = await Promise.all(ids.map(async (id) => {
        try {
          const r = await fetch(`/api/rules/${id}`, { method: 'DELETE', credentials: 'include' })
          const j = await r.json().catch(()=>({}))
          return { ok: r.ok && !j?.error, j }
        } catch (e) {
          return { ok: false, e }
        }
      }))
      const failed = results.filter(x => !x.ok).length
      if (failed) {
        if (onToast) onToast(`${failed} failed, ${ids.length - failed} deleted`, true)
      } else {
        if (onToast) onToast(`Deleted ${ids.length} rule(s)`) }
      clearSelection()
      load()
    } catch (e) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const bulkSetStatus = async (status) => {
    const ids = bulkScope === 'filtered' ? filtered.map(r=>r.id) : (allResourcesSelected ? paginated.map(r=>r.id) : selectedResources)
    if (!ids.length) return
    try {
      setBusy(true)
      const results = await Promise.all(ids.map(async (id) => {
        try {
          const r = await fetch(`/api/rules/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status }) })
          const j = await r.json().catch(()=>({}))
          return { ok: r.ok && !j?.error, j }
        } catch (e) {
          return { ok: false, e }
        }
      }))
      const failed = results.filter(x => !x.ok).length
      if (failed) {
        if (onToast) onToast(`${failed} failed, ${ids.length - failed} updated`, true)
      } else {
        if (onToast) onToast(`Updated ${ids.length} rule(s)`) }
      clearSelection()
      load()
    } catch (e) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <BlockStack gap="200">
      {err && <Banner status="critical">{err}</Banner>}
      {msg && <Banner status={msg.tone === 'success' ? 'success' : 'info'}>{msg.text}</Banner>}

      <InlineStack gap="200" align="space-between">
        <InlineStack gap="200">
          <Text as="h3" variant="headingSm">Rules</Text>
          <InlineStack gap="100">
            <Badge tone="attention">Total: {totalAll}</Badge>
            <Badge tone="success">Active: {totalActive}</Badge>
            <Badge tone="critical">Inactive: {totalInactive}</Badge>
          </InlineStack>
        </InlineStack>
        <InlineStack gap="200">
          <Button onClick={load} variant="secondary" disabled={loading || busy}>Refresh</Button>
          <Button onClick={onExport} variant="secondary" disabled={loading || busy}>Export</Button>
          <Button onClick={onExportFiltered} variant="secondary" disabled={loading || busy}>Export filtered</Button>
          <Button onClick={copyFilteredIds} variant="secondary" disabled={loading || busy}>Copy IDs</Button>
          <Button onClick={onImportClick} variant="secondary" disabled={loading || busy}>Import</Button>
          <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={onImportFile} />
        </InlineStack>
      </InlineStack>

      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'white', paddingTop: 8, paddingBottom: 8 }}>
        <InlineStack gap="200" align="space-between">
          <InlineStack gap="200">
            <TextField label="Search" labelHidden value={qInput} onChange={(v)=>{ setPage(1); setQInput(v) }} placeholder="Search by id/name" autoComplete="off" />
            <Select label="Status" labelHidden value={fStatus} onChange={(v)=>{ setPage(1); setFStatus(v) }} options={[{label:'All status', value:'all'},{label:'Active', value:'active'},{label:'Inactive', value:'inactive'}]} />
            <Select label="Placement" labelHidden value={fPlacement} onChange={(v)=>{ setPage(1); setFPlacement(v) }} options={[{label:'All placements', value:'all'},{label:'Product Page', value:'product_page'},{label:'Cart', value:'cart'}]} />
            <Select label="Sort by" labelHidden value={sortKey} onChange={setSortKey} options={[{label:'ID', value:'id'},{label:'Name', value:'name'},{label:'Priority', value:'prio'},{label:'Impressions', value:'impr'},{label:'Rate', value:'rate'},{label:'Revenue', value:'revenue'}]} />
            <Select label="Order" labelHidden value={sortDir} onChange={setSortDir} options={[{label:'Desc', value:'desc'},{label:'Asc', value:'asc'}]} />
            <Select label="Per page" labelHidden value={String(perPage)} onChange={(v)=>{ setPerPage(parseInt(v)||10); setPage(1) }} options={[{label:'10', value:'10'},{label:'25', value:'25'},{label:'50', value:'50'}]} />
            {anyFilter && <Button variant="secondary" onClick={clearFilters}>Clear</Button>}
            <Tooltip content={<div>Impr: Impressions<br/>Accept: Accepted offers<br/>Rate: Accept / Impr<br/>Revenue: Sum of accepted value<br/>Discount: Sum of discounts</div>}>
              <Button size="slim" variant="secondary">Metrics legend</Button>
            </Tooltip>
            <InlineStack gap="100">
              <Button size="slim" variant={fStatus==='active'?'primary':'secondary'} onClick={()=>{ setFStatus(fStatus==='active'?'all':'active'); setPage(1) }}>Active</Button>
              <Button size="slim" variant={fStatus==='inactive'?'primary':'secondary'} onClick={()=>{ setFStatus(fStatus==='inactive'?'all':'inactive'); setPage(1) }}>Inactive</Button>
              <Button size="slim" variant={fPlacement==='product_page'?'primary':'secondary'} onClick={()=>{ setFPlacement(fPlacement==='product_page'?'all':'product_page'); setPage(1) }}>Product Page</Button>
              <Button size="slim" variant={fPlacement==='cart'?'primary':'secondary'} onClick={()=>{ setFPlacement(fPlacement==='cart'?'all':'cart'); setPage(1) }}>Cart</Button>
            </InlineStack>
          </InlineStack>
          {hasSelection && (
            <InlineStack gap="100" align="end">
              <InlineStack gap="100">
                <Button size="slim" tone="critical" onClick={bulkDelete} disabled={busy}>Delete selected</Button>
                <Button size="slim" onClick={()=>bulkSetStatus('active')} disabled={busy}>Activate</Button>
                <Button size="slim" onClick={()=>bulkSetStatus('inactive')} disabled={busy}>Deactivate</Button>
              </InlineStack>
              <InlineStack gap="100">
                <Text as="span" variant="bodySm">Scope:</Text>
                <Button size="slim" variant={bulkScope==='page'?'primary':'secondary'} onClick={()=>setBulkScope('page')} disabled={busy}>This page</Button>
                <Button size="slim" variant={bulkScope==='filtered'?'primary':'secondary'} onClick={()=>setBulkScope('filtered')} disabled={busy}>All filtered</Button>
              </InlineStack>
            </InlineStack>
          )}
      </InlineStack>
      </div>

      <InlineStack align="space-between">
        <Text as="span" variant="bodySm" tone="subdued">Showing {totalCount ? (start + 1) : 0}–{end} of {totalCount}</Text>
        {lastLoaded && <Text as="span" variant="bodySm" tone="subdued">Last refresh: {new Date(lastLoaded).toLocaleTimeString()}</Text>}
 
      </InlineStack>
      {loading ? (
        <BlockStack gap="200">
          <SkeletonDisplayText size="small" />
          <SkeletonBodyText lines={5} />
        </BlockStack>
      ) : paginated.length === 0 ? (
        <Card>
          <EmptyState
            heading={anyFilter ? 'No rules match your filters' : 'No rules yet'}
            action={anyFilter ? { content: 'Clear filters', onAction: clearFilters } : { content: 'Refresh', onAction: load }}
            secondaryAction={{ content: 'Export', onAction: onExport }}
            image="/static/img/boopug.svg"
          >
            <p>{anyFilter ? 'Try adjusting or clearing your filters.' : 'Create a new rule in the Create Rule tab to get started.'}</p>
          </EmptyState>
        </Card>
      ) : (
        <IndexTable
          resourceName={resourceName}
          itemCount={paginated.length}
          selectedItemsCount={allResourcesSelected ? 'All' : (selectedResources?.length || 0)}
          onSelectionChange={handleSelectionChange}
          selectable
          headings={[
            { title: 'ID' },
            { title: 'Name' },
            { title: 'Placement' },
            { title: 'Status' },
            { title: 'Prio' },
            { title: 'Limit' },
            { title: 'A/B%' },
            { title: 'Impr' },
            { title: 'Accept' },
            { title: 'Rate' },
            { title: 'Revenue' },
            { title: 'Discount' },
            { title: 'Actions' },
          ]}
        >
          {paginated.map((r, index) => {
            const isSelected = !!allResourcesSelected || (Array.isArray(selectedResources) && selectedResources.map(String).includes(String(r.id)))
            return (
            <IndexTable.Row id={String(r.id)} key={r.id} position={index} selected={isSelected}>
              <IndexTable.Cell>
                <InlineStack gap="100" align="start">
                  <Text as="span">#{r.rid}</Text>
                  <Button size="slim" variant="secondary" onClick={(e)=>{ e.stopPropagation(); try{ navigator.clipboard.writeText(String(r.id)); if (onToast) onToast('Copied ID') } catch{} }}>Copy</Button>
                </InlineStack>
              </IndexTable.Cell>
              <IndexTable.Cell><Text as="span" tone={r.status === 'inactive' ? 'subdued' : undefined}>{r.name}</Text></IndexTable.Cell>
              <IndexTable.Cell><Badge tone={r.placement === 'product_page' ? 'info' : 'attention'}>{r.placement}</Badge></IndexTable.Cell>
              <IndexTable.Cell>
                <Badge tone={r.status === 'active' ? 'success' : 'critical'}>{r.status}</Badge>
              </IndexTable.Cell>
              <IndexTable.Cell><Text alignment="end">{nf0.format(r.priority)}</Text></IndexTable.Cell>
              <IndexTable.Cell><Text alignment="end">{nf0.format(r.limit)}</Text></IndexTable.Cell>
              <IndexTable.Cell><Text alignment="end">{nf0.format(r.ab)}</Text></IndexTable.Cell>
              <IndexTable.Cell><Text alignment="end">{nf0.format(r.impr)}</Text></IndexTable.Cell>
              <IndexTable.Cell><Text alignment="end">{nf0.format(r.acc)}</Text></IndexTable.Cell>
              <IndexTable.Cell>
                <InlineStack align="end">
                  {(() => {
                    const pct = (r.rate * 100)
                    const tone = pct >= 20 ? 'success' : (pct >= 10 ? 'attention' : 'critical')
                    return <Badge tone={tone}>{pct.toFixed(1)}%</Badge>
                  })()}
                </InlineStack>
              </IndexTable.Cell>
              <IndexTable.Cell><Text alignment="end">${nf2.format(r.revenue)}</Text></IndexTable.Cell>
              <IndexTable.Cell><Text alignment="end">-${nf2.format(r.discount)}</Text></IndexTable.Cell>
              <IndexTable.Cell>
                <InlineStack gap="100">
                  <Tooltip content="Edit rule">
                    <Button size="slim" disabled={disableRowActions} onClick={(e) => { e.stopPropagation(); openEdit(r) }}>Edit</Button>
                  </Tooltip>
                  <Tooltip content={r.status === 'active' ? 'Deactivate rule' : 'Activate rule'}>
                    <Button size="slim" disabled={disableRowActions} onClick={(e) => { e.stopPropagation(); onToggleStatus(r) }}>{r.status === 'active' ? 'Deactivate' : 'Activate'}</Button>
                  </Tooltip>
                  <Tooltip content="Delete rule">
                    <Button size="slim" disabled={disableRowActions} onClick={(e) => { e.stopPropagation(); onDelete(r.id) }} tone="critical">Delete</Button>
                  </Tooltip>
                  <Tooltip content="Open legacy admin">
                    <Button size="slim" disabled={disableRowActions} url={`/admin-legacy#r=${r.id}`} target="_blank" onClick={(e) => { e.stopPropagation() }}>Legacy</Button>
                  </Tooltip>
                </InlineStack>
              </IndexTable.Cell>
            </IndexTable.Row>
            )
          })}
        </IndexTable>
      )}

      {!loading && (
        <InlineStack align="end">
          <Pagination
            hasPrevious={currentPage > 1}
            onPrevious={() => setPage(p => Math.max(1, p - 1))}
            hasNext={currentPage < totalPages}
            onNext={() => setPage(p => Math.min(totalPages, p + 1))}
          />
          <Text as="span" variant="bodySm">Page {currentPage}/{totalPages}</Text>
        </InlineStack>
      )}

      <Text as="span" variant="bodySm" tone="subdued">Filtered totals — Impr: {nf0.format(totals.impr)} · Accept: {nf0.format(totals.acc)} · Rate: {(totals.rate*100).toFixed(1)}% · Revenue: ${nf2.format(totals.revenue)} · Discount: -${nf2.format(totals.discount)}</Text>

      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit ? `Edit Rule #${edit.id}` : 'Edit Rule'}
        primaryAction={{ content: 'Save', onAction: saveEdit, loading: savingEdit }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setEdit(null) }]}
      >
        <Modal.Section>
          {edit && (
            <BlockStack gap="200">
              <TextField label="Name" value={edit.name} onChange={(v)=>setEdit(e=>({ ...e, name: v }))} autoComplete="off" />
              <Select label="Status" value={edit.status} onChange={(v)=>setEdit(e=>({ ...e, status: v }))} options={[{label:'Active', value:'active'},{label:'Inactive', value:'inactive'}]} />
              <InlineStack gap="300">
                <TextField label="Priority" type="number" value={edit.priority} onChange={(v)=>setEdit(e=>({ ...e, priority: v }))} autoComplete="off" />
                <TextField label="Limit" type="number" value={edit.limit} onChange={(v)=>setEdit(e=>({ ...e, limit: v }))} autoComplete="off" />
                <TextField label="A/B % (treatment)" type="number" value={edit.ab} onChange={(v)=>setEdit(e=>({ ...e, ab: v }))} autoComplete="off" />
              </InlineStack>
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </BlockStack>
  )
}

function AnalyticsSummary() {
  const [loading, setLoading] = React.useState(true)
  const [summary, setSummary] = React.useState({})
  const [err, setErr] = React.useState(null)
  const [lastLoaded, setLastLoaded] = React.useState(null)
  const [autoRefresh, setAutoRefresh] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch('/api/analytics/summary', { credentials: 'include' })
      const j = await r.json()
      setSummary(j.summary || {})
      setLastLoaded(Date.now())
    } catch (e) {
      setErr(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { load() }, [load])

  // Auto-refresh every 30s when enabled
  React.useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => { load() }, 30000)
    return () => clearInterval(id)
  }, [autoRefresh, load])

  // Refresh when rules are changed elsewhere (e.g., import)
  React.useEffect(() => {
    const h = () => load()
    window.addEventListener('rules:changed', h)
    return () => window.removeEventListener('rules:changed', h)
  }, [load])

  // Formatters and derived values
  const nf0 = React.useMemo(() => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }), [])
  const ratePct = React.useMemo(() => {
    const impr = summary.impression || 0
    const acc = summary.accept || 0
    return impr ? (acc / impr) * 100 : 0
  }, [summary])

  // Copy analytics metrics to clipboard
  const copyMetrics = async () => {
    try {
      const payload = { ...summary, rate_pct: ratePct }
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    } catch {}
  }
  return (
    <BlockStack gap="200">
      <InlineStack align="space-between">
        <Text as="h3" variant="headingSm">Analytics</Text>
        <InlineStack gap="200">
          <Checkbox label="Auto-refresh" checked={autoRefresh} onChange={(v)=>setAutoRefresh(!!v)} />
          <Button onClick={copyMetrics} variant="secondary">Copy metrics</Button>
          <Button onClick={load} variant="secondary">Refresh</Button>
        </InlineStack>
      </InlineStack>
      {err && <Banner status="critical">{err}</Banner>}
      {lastLoaded && <Text as="span" variant="bodySm" tone="subdued">Last refresh: {new Date(lastLoaded).toLocaleTimeString()}</Text>}
      {loading ? (
        <InlineStack gap="200"><Spinner size="small" /> <Text as="span" variant="bodySm">Loading…</Text></InlineStack>
      ) : (
        <InlineStack gap="300">
          <Badge>impression: {nf0.format(summary.impression || 0)}</Badge>
          <Badge>control: {nf0.format(summary.impression_control || 0)}</Badge>
          <Badge>accept: {nf0.format(summary.accept || 0)}</Badge>
          <Badge tone={ratePct>=20?'success':(ratePct>=10?'attention':'critical')}>rate: {ratePct.toFixed(1)}%</Badge>
        </InlineStack>
      )}
    </BlockStack>
  )
}

function App() {
  const abConfig = useAppBridgeConfig()

  React.useEffect(() => {
    if (!abConfig || !abConfig.apiKey) return
    import('@shopify/app-bridge').then(({ default: createApp }) => {
      try { createApp(abConfig) } catch (_e) {}
    })
  }, [abConfig])

  const [health, setHealth] = React.useState(null)
  React.useEffect(() => {
    fetch('/api/health', { credentials: 'include' })
      .then(r => r.json()).then(setHealth).catch(()=>{})
  }, [])

  const [tab, setTab] = React.useState(0)

  // Toasts
  const [toastText, setToastText] = React.useState('')
  const [toastError, setToastError] = React.useState(false)
  const [toastActive, setToastActive] = React.useState(false)
  const onToast = React.useCallback((text, isError = false) => {
    setToastText(String(text || ''))
    setToastError(!!isError)
    setToastActive(true)
  }, [])
  const toastMarkup = toastActive ? (
    <Toast content={toastText} error={toastError} onDismiss={() => setToastActive(false)} />
  ) : null

  return (
    <AppProvider i18n={{}}>
      <Frame>
        {toastMarkup}
        <Page title="BooPug Upsell Rules">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">Welcome to the new embedded admin.</Text>
                {health && <Text as="p" variant="bodySm" tone="success">API OK: {String(health.ok)}</Text>}
              </BlockStack>
            </Card>
            <Card>
              <Tabs
                tabs={[
                  { id: 'create', content: 'Create Rule' },
                  { id: 'rules', content: 'Rules' },
                  { id: 'analytics', content: 'Analytics' },
                ]}
                selected={tab}
                onSelect={setTab}
              >
                {tab === 0 && <CreateRuleForm onToast={onToast} />}
                {tab === 1 && <RulesTable onToast={onToast} />}
                {tab === 2 && <AnalyticsSummary />}
              </Tabs>
            </Card>
          </BlockStack>
        </Page>
      </Frame>
    </AppProvider>
  )
}

function CreateRuleForm({ onToast }) {
  const [catalog, setCatalog] = React.useState([])
  const [saving, setSaving] = React.useState(false)
  const [msg, setMsg] = React.useState(null)
  const [dirty, setDirty] = React.useState(false)

  // Core fields
  const [name, setName] = React.useState('')
  const [placement, setPlacement] = React.useState('product_page')
  const [limit, setLimit] = React.useState('1')
  const [priority, setPriority] = React.useState('100')
  const [cap, setCap] = React.useState('0')
  const [abpct, setAbpct] = React.useState('100')
  const [scheduleStart, setScheduleStart] = React.useState('')
  const [scheduleEnd, setScheduleEnd] = React.useState('')

  // Conditions
  const [tags, setTags] = React.useState('')
  const [cols, setCols] = React.useState('')
  const [minSubtotal, setMinSubtotal] = React.useState('')
  const [maxSubtotal, setMaxSubtotal] = React.useState('')

  // Suggestions
  const [sugs, setSugs] = React.useState([{ product_id: '', discount_pct: '0' }])

  // Naming UX
  const [autoName, setAutoName] = React.useState(true)
  const suggestedName = React.useMemo(() => {
    const placementLabel = placement === 'product_page' ? 'Product Page' : (placement === 'cart' ? 'Cart' : placement)
    const tagsArr = tags.split(',').map(s=>s.trim()).filter(Boolean)
    const colsArr = cols.split(',').map(s=>s.trim()).filter(Boolean)
    const ctx = []
    if (tagsArr.length) ctx.push(`tags: ${tagsArr.join(', ')}`)
    if (colsArr.length) ctx.push(`collections: ${colsArr.join(', ')}`)
    const contextStr = ctx.length ? ` (${ctx.join(', ')})` : ''

    const chosen = sugs.filter(s => s.product_id)
    let arrowStr = ''
    let discountStr = ''
    if (chosen.length) {
      const titles = chosen.map(s => {
        const id = parseInt(s.product_id)
        const p = catalog.find(x => String(x.id) === String(id))
        return p ? p.title : `#${id}`
      })
      const first = titles[0]
      const more = titles.length > 1 ? ` +${titles.length - 1}` : ''
      arrowStr = ` → ${first}${more}`
      const dset = Array.from(new Set(chosen.map(s => parseInt(s.discount_pct||'0')).filter(n => !isNaN(n))))
      if (dset.length === 1 && dset[0] > 0) discountStr = ` · ${dset[0]}% off`
    }
    return `Upsell: ${placementLabel}${contextStr}${arrowStr}${discountStr}`.trim()
  }, [placement, tags, cols, sugs, catalog])

  React.useEffect(() => {
    if (autoName && suggestedName && name !== suggestedName) {
      setName(suggestedName)
    }
  }, [autoName, suggestedName])

  // Warn if navigating away with unsaved changes
  React.useEffect(() => {
    const handler = (e) => {
      if (dirty && !saving) {
        e.preventDefault()
        e.returnValue = ''
        return ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty, saving])

  React.useEffect(() => {
    fetch('/api/catalog', { credentials: 'include' })
      .then(r => r.json()).then(d => setCatalog(d.items || [])).catch(()=>setCatalog([]))
  }, [])

  const addSug = () => setSugs(s => [...s, { product_id: '', discount_pct: '0' }])
  const updSug = (i, k, v) => { setDirty(true); setSugs(s => s.map((row, idx) => idx===i ? { ...row, [k]: v } : row)) }
  const delSug = (i) => { setDirty(true); setSugs(s => s.filter((_, idx) => idx!==i)) }

  const toTs = (s) => { try { return s ? Math.floor(new Date(s).getTime()/1000) : null } catch { return null } }

  // Validation
  const errors = React.useMemo(() => {
    const e = {}
    const toInt = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n }
    const toNum = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n }
    const l = toInt(limit); if (l === null || l < 1) e.limit = 'Must be at least 1'
    const p = toInt(priority); if (p === null) e.priority = 'Required integer'
    const c = toInt(cap); if (c === null || c < 0) e.cap = 'Must be 0 or higher'
    const a = toInt(abpct); if (a === null || a < 0 || a > 100) e.abpct = '0–100'
    // schedule
    try {
      const st = scheduleStart ? new Date(scheduleStart).getTime() : null
      const en = scheduleEnd ? new Date(scheduleEnd).getTime() : null
      if (st && en && en < st) e.schedule = 'End must be after start'
    } catch {}
    // suggestions discounts
    e.sugs = sugs.map(s => {
      const d = toNum(s.discount_pct)
      return (d === null || d < 0 || d > 100) ? { discount: '0–100' } : null
    })
    return e
  }, [limit, priority, cap, abpct, scheduleStart, scheduleEnd, sugs])

  const hasErrors = React.useMemo(() => {
    if (errors.limit || errors.priority || errors.cap || errors.abpct || errors.schedule) return true
    if (errors.sugs && errors.sugs.some(x => !!x)) return true
    return false
  }, [errors])

  const buildPayload = () => {
    const conditions = {}
    const tagsArr = tags.split(',').map(s=>s.trim()).filter(Boolean)
    if (tagsArr.length) conditions.product_tags_any = tagsArr
    const colsArr = cols.split(',').map(s=>s.trim()).filter(Boolean)
    if (colsArr.length) conditions.product_collections_any = colsArr
    const mn = parseFloat(minSubtotal), mx = parseFloat(maxSubtotal)
    if (!isNaN(mn) || !isNaN(mx)) conditions.cart_subtotal_between = { min: isNaN(mn)?0:mn, max: isNaN(mx)?999999:mx }

    const suggestions = sugs
      .map(s => ({ product_id: s.product_id ? parseInt(s.product_id) : null, discount_pct: parseInt(s.discount_pct||'0') }))
      .filter(s => s.product_id)

    const payload = {
      name: name || 'New Rule',
      placement,
      limit: parseInt(limit||'1'),
      priority: parseInt(priority||'100'),
      per_session_cap: parseInt(cap||'0'),
      ab_test_pct: parseInt(abpct||'100'),
      schedule_start: toTs(scheduleStart),
      schedule_end: toTs(scheduleEnd),
      status: 'active',
      conditions,
      suggestions,
    }
    return payload
  }

  const onSubmit = async () => {
    setSaving(true); setMsg(null)
    try {
      if (hasErrors) throw new Error('Please fix validation errors')
      const payload = buildPayload()
      const r = await fetch('/api/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) })
      const j = await r.json()
      if (!r.ok || j.error) throw new Error(j.error || 'Failed')
      if (onToast) onToast(`Rule created (id ${j.id})`)
      // Reset a few fields but keep context
      setName(''); setSugs([{ product_id: '', discount_pct: '0' }]); setDirty(false); setAutoName(true)
      try { window.dispatchEvent(new CustomEvent('rules:changed')) } catch (_e) {}
    } catch (e) {
      setMsg({ tone: 'critical', text: e?.message || String(e) })
      if (onToast) onToast(e?.message || String(e), true)
    } finally {
      setSaving(false)
    }
  }

  const copyJson = async () => {
    try {
      const payload = buildPayload()
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      if (onToast) onToast('Rule JSON copied')
    } catch (e) {
      if (onToast) onToast('Failed to copy JSON', true)
    }
  }

  const resetForm = () => {
    setName('')
    setPlacement('product_page')
    setLimit('1')
    setPriority('100')
    setCap('0')
    setAbpct('100')
    setScheduleStart('')
    setScheduleEnd('')
    setTags('')
    setCols('')
    setMinSubtotal('')
    setMaxSubtotal('')
    setSugs([{ product_id: '', discount_pct: '0' }])
    setAutoName(true)
    setDirty(false)
  }

  return (
    <BlockStack gap="300">
      {msg && <Banner status={msg.tone === 'success' ? 'success' : 'critical'}>{msg.text}</Banner>}
      <FormLayout>
        <TextField label="Name" value={name} onChange={(v)=>{ setDirty(true); setAutoName(false); setName(v) }} autoComplete="off" placeholder="Camera → SD Card" helpText="Give this rule a clear name. You can use the Suggested name or type your own." />
        <InlineStack align="space-between" gap="200">
          <Text as="span" variant="bodySm" tone="subdued">Suggested: {suggestedName || '—'}</Text>
          <InlineStack gap="200" align="end">
            <Button variant="secondary" disabled={!suggestedName} onClick={() => { setDirty(true); setName(suggestedName); setAutoName(false) }}>Use suggestion</Button>
            <Checkbox label="Auto-generate name" checked={autoName} onChange={(v)=>{ setDirty(true); setAutoName(!!v); if (v && suggestedName) setName(suggestedName) }} />
          </InlineStack>
        </InlineStack>
        <InlineStack gap="300">
          <Select label="Placement" value={placement} onChange={(v)=>{ setDirty(true); setPlacement(v) }} options={[{label:'Product Page', value:'product_page'},{label:'Cart', value:'cart'}]} helpText="Where the upsell will be shown." />
          <TextField label="Limit" type="number" value={limit} onChange={(v)=>{ setDirty(true); setLimit(v) }} autoComplete="off" helpText="Max number of suggestions to show at once." error={errors.limit} />
          <TextField label="Priority" type="number" value={priority} onChange={(v)=>{ setDirty(true); setPriority(v) }} autoComplete="off" helpText="Higher priority runs first when multiple rules match (default 100)." error={errors.priority} />
          <TextField label="Per-session cap" type="number" value={cap} onChange={(v)=>{ setDirty(true); setCap(v) }} autoComplete="off" helpText="Max times this rule can show per session. 0 = unlimited." error={errors.cap} />
          <TextField label="A/B % (treatment)" type="number" value={abpct} onChange={(v)=>{ setDirty(true); setAbpct(v) }} autoComplete="off" helpText="Percent of traffic that sees the upsell (treatment). Remaining sees control." error={errors.abpct} />
        </InlineStack>
        <InlineStack gap="300">
          <TextField label="Schedule start" type="datetime-local" value={scheduleStart} onChange={(v)=>{ setDirty(true); setScheduleStart(v) }} helpText="Optional start time. Leave blank to start immediately." />
          <TextField label="Schedule end" type="datetime-local" value={scheduleEnd} onChange={(v)=>{ setDirty(true); setScheduleEnd(v) }} helpText="Optional end time. Leave blank to never expire." error={errors.schedule} />
        </InlineStack>

        <Text as="h3" variant="headingSm">Conditions</Text>
        <InlineStack gap="300">
          <TextField label="Product tags (comma)" value={tags} onChange={(v)=>{ setDirty(true); setTags(v) }} autoComplete="off" helpText="Match if the product has ANY of these tags." />
          <TextField label="Collections (comma)" value={cols} onChange={(v)=>{ setDirty(true); setCols(v) }} autoComplete="off" helpText="Match if the product is in ANY of these collections." />
          <TextField label="Cart subtotal min" type="number" value={minSubtotal} onChange={(v)=>{ setDirty(true); setMinSubtotal(v) }} autoComplete="off" helpText="Only apply when subtotal is at least this amount." />
          <TextField label="Cart subtotal max" type="number" value={maxSubtotal} onChange={(v)=>{ setDirty(true); setMaxSubtotal(v) }} autoComplete="off" helpText="Only apply when subtotal is at most this amount." />
        </InlineStack>

        <Text as="h3" variant="headingSm">Suggestions</Text>
        <BlockStack gap="200">
          {sugs.map((row, i) => (
            <InlineStack key={i} gap="300" align="end">
              <Select
                label="Product"
                value={row.product_id}
                onChange={(v)=>updSug(i,'product_id',v)}
                options={[{label:'Choose a product', value:''}, ...catalog.map(p=>({label:`${p.title} (#${p.id})`, value:String(p.id)}))]}
                helpText="Product to suggest as an upsell."
              />
              <TextField label="Discount %" type="number" value={row.discount_pct} onChange={(v)=>updSug(i,'discount_pct',v)} autoComplete="off" helpText="Optional discount to apply. Use 0 for no discount." error={errors.sugs?.[i]?.discount} />
              <Button tone="critical" onClick={()=>delSug(i)}>Remove</Button>
            </InlineStack>
          ))}
          <Button onClick={()=>{ setDirty(true); addSug() }} variant="secondary">Add suggestion</Button>
        </BlockStack>

        <InlineStack gap="300">
          <Button variant="primary" loading={saving} disabled={saving || hasErrors} onClick={onSubmit}>Create Rule</Button>
          <Button variant="secondary" onClick={copyJson}>Copy JSON</Button>
          <Button variant="secondary" tone="critical" onClick={resetForm}>Reset</Button>
          <Button url="/admin-legacy" target="_blank">Open legacy admin</Button>
        </InlineStack>
        {hasErrors && <Text as="span" variant="bodySm" tone="critical">Please fix validation errors before submitting.</Text>}
        {dirty && !saving && <Text as="span" variant="bodySm" tone="subdued">You have unsaved changes.</Text>}
      </FormLayout>
    </BlockStack>
  )
}

createRoot(document.getElementById('root')).render(<App />)
