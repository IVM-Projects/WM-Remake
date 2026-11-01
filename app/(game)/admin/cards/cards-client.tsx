'use client'

import { Layers } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { ActionModal } from '@/components/admin/ActionModal'
import { flagsConsequence } from '@/components/admin/flags'
import type { CardDetail, RemovalRow, StaffRole } from '@/components/admin/types'
import { Card } from '@/components/card/Card'
import { PageHeader } from '@/components/shell/PageHeader'
import { link, ghost } from '@/components/ui/button'
import { DataTable } from '@/components/ui/DataTable'
import { LoadError } from '@/components/ui/LoadError'
import { Loading } from '@/components/ui/Loading'
import { toast } from '@/components/ui/toast'
import { CatalogPicker } from '@/components/guild/CatalogPicker'
import { api, apiOnce } from '@/lib/api'
import { formatInt, formatShortDate } from '@/lib/format'

type Modal = 'hide' | 'nsfw' | 'remove' | 'restore' | 'quiz'
// Pluriel français : 0 et 1 au singulier.
const count = (n: number, one: string, many: string) => `${formatInt(n)} ${n > 1 ? many : one}`
const ENGAGEMENTS = [
  ['active_auctions', 'vente active', 'ventes actives'], ['pending_trades', 'échange en attente', 'échanges en attente'],
  ['open_wishes', 'demande de guilde', 'demandes de guilde'], ['showcase', 'vitrine', 'vitrines'], ['avatars', 'avatar', 'avatars'],
] as const

const readableDetail = (d: CardDetail | null): CardDetail | null =>
  d && d.card && typeof d.card.wikipedia_title === 'string' && d.engagements && typeof d.engagements === 'object' ? d : null
const readableRemovals = (r: { removals?: RemovalRow[] } | null): RemovalRow[] | null => (Array.isArray(r?.removals) ? r.removals : null)

// /admin/cards : choix d'une carte du catalogue (?card=<id>), drapeaux d'image, retrait et remise (administrateurs), banque de quiz, cartes retirées.
// Les actions d'administrateur sont masquées aux modérateurs : l'interface les cache, l'API les refuse.
export function CardsClient({ role }: { role: StaffRole }) {
  const id = useId()
  const router = useRouter()
  const cardId = useSearchParams().get('card') || null
  const [detail, setDetail] = useState<CardDetail | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  const [settled, setSettled] = useState<string | null>(null)
  const [removals, setRemovals] = useState<RemovalRow[] | null>(null)
  const [removalsFailed, setRemovalsFailed] = useState(false)
  const [removalsDone, setRemovalsDone] = useState(false)
  const [picker, setPicker] = useState(false)
  const [modal, setModal] = useState<Modal | null>(null)
  const detailGen = useRef(0)
  const removalsGen = useRef(0)
  const [keys] = useState(() => new Map<string, string>())
  const heading = useRef<HTMLHeadingElement>(null)
  const retryDetail = useRef<HTMLButtonElement>(null)
  const removedHeading = useRef<HTMLHeadingElement>(null)
  const retryRemovals = useRef<HTMLButtonElement>(null)
  const focusRemoved = useRef(false)
  const focusAfter = useRef(false)

  const readDetail = (cid: string) => {
    const g = ++detailGen.current
    return api<CardDetail | null>(`/api/admin/cards/${cid}`).then(readableDetail, () => null).then((d) => {
      if (g !== detailGen.current) return
      setDetail(d)
      setDetailFailed(!d)
      setSettled(cid)
    })
  }
  const readRemovals = () => {
    const g = ++removalsGen.current
    return api<{ removals?: RemovalRow[] } | null>('/api/admin/removals').then(readableRemovals, () => null).then((r) => {
      if (g !== removalsGen.current) return
      setRemovals(r)
      setRemovalsFailed(!r)
      setRemovalsDone(true)
    })
  }
  // Autre carte : la fiche d'avant n'est plus montrée (état ajusté au rendu), la réponse d'une lecture quittée est jetée (génération).
  const [shown, setShown] = useState(cardId)
  if (shown !== cardId) {
    setShown(cardId); setDetail(null); setDetailFailed(false); setModal(null)
  }
  const onCard = useEffectEvent((cid: string | null) => {
    if (cid) void readDetail(cid)
    else detailGen.current++
  })
  useEffect(() => { onCard(cardId) }, [cardId])
  const onMount = useEffectEvent(() => { void readRemovals() })
  useEffect(() => { onMount() }, [])

  useEffect(() => {
    if (!focusAfter.current || !(detail || detailFailed)) return
    focusAfter.current = false
    ;(detailFailed ? retryDetail.current : heading.current)?.focus()
  }, [detail, detailFailed])

  useEffect(() => {
    if (!focusRemoved.current || !(removals || removalsFailed)) return
    focusRemoved.current = false
    ;(removalsFailed ? retryRemovals.current : removedHeading.current)?.focus()
  }, [removals, removalsFailed])

  // Action réussie : modale fermée, fiche et liste des retraits relues.
  const done = () => {
    setModal(null)
    focusAfter.current = true
    if (cardId) void readDetail(cardId)
    void readRemovals()
  }
  const post = async <T,>(intent: string, path: string, method: 'POST' | 'DELETE', reason: string, extra: object = {}) => {
    const res = await apiOnce<T | null>(keys, `${intent}:${reason}`, path, { method, body: JSON.stringify({ ...extra, reason }) })
    if (!res) throw new Error('unreadable')
    return res
  }

  const admin = role === 'admin'
  const d = detail
  const c = d?.card
  const ready = removalsDone && (!cardId || settled === cardId)
  const base = `/api/admin/cards/${cardId}`

  return (
    <div data-ready={ready ? '' : undefined} className="space-y-6">
      <PageHeader title="Cartes" icon={Layers} />
      <button type="button" onClick={() => setPicker(true)} className={ghost}>Choisir une carte</button>

      {cardId && (d && c ? (
        <section aria-labelledby={`${id}-name`} className="space-y-4">
          <div className="card-frame flex flex-wrap items-start gap-4 p-4">
            <Card card={c} size="grid" />
            <div className="min-w-0 flex-1 basis-48 space-y-2">
              <h2 ref={heading} id={`${id}-name`} tabIndex={-1} className="text-xl font-bold outline-none wrap-anywhere">{c.wikipedia_title}</h2>
              <ul className="space-y-1 text-sm">
                <li>{`Rareté : ${c.rarity}`}</li>
                {c.hide_image && <li className="font-medium">Image masquée</li>}
                {c.nsfw_image && <li className="font-medium">Image sensible</li>}
                {d.removal && <li className="font-medium wrap-anywhere">{`Retirée le ${formatShortDate(d.removal.removed_at)} : ${d.removal.reason}`}</li>}
                <li>{count(d.image_reports, 'signalement d\'image', 'signalements d\'image')}</li>
                <li>{`Banque de quiz : ${d.quiz_bank ? 'oui' : 'non'}`}</li>
              </ul>
              <h3 className="pt-1 text-sm font-bold">Engagements en cours</h3>
              <ul className="space-y-1 text-sm">
                {ENGAGEMENTS.map(([k, one, many]) => <li key={k}>{count(d.engagements[k], one, many)}</li>)}
              </ul>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => setModal('hide')} className={ghost}>{c.hide_image ? 'Afficher l\'image' : 'Masquer l\'image'}</button>
            <button type="button" onClick={() => setModal('nsfw')} className={ghost}>{c.nsfw_image ? 'Retirer « sensible »' : 'Marquer sensible'}</button>
            {admin && (d.removal
              ? <button type="button" onClick={() => setModal('restore')} className={ghost}>Remettre la carte</button>
              : <button type="button" onClick={() => setModal('remove')} className={ghost}>Retirer la carte</button>)}
            {admin && <button type="button" onClick={() => setModal('quiz')} className={ghost}>Effacer la banque de quiz</button>}
          </div>
        </section>
      ) : detailFailed ? (
        <LoadError ref={retryDetail} text="La fiche n'a pas pu être chargée." onRetry={() => { focusAfter.current = true; setDetailFailed(false); void readDetail(cardId) }} />
      ) : <Loading label="Chargement de la fiche" />)}

      <section aria-labelledby={`${id}-removed`} className="space-y-2">
        <h2 ref={removedHeading} id={`${id}-removed`} tabIndex={-1} className="text-lg font-bold outline-none">Cartes retirées</h2>
        {removals ? (removals.length ? (
          <DataTable<RemovalRow>
            caption="Cartes retirées"
            rows={removals}
            rowKey={(r) => r.card_id}
            columns={[
              { key: 'card', header: 'Carte', cellClassName: 'wrap-anywhere', cell: (r) => <Link href={`/admin/cards?card=${r.card_id}`} className={`${link} wrap-anywhere`}>{r.wikipedia_title}</Link> },
              { key: 'reason', header: 'Motif', cellClassName: 'wrap-anywhere', cell: (r) => r.reason },
              { key: 'at', header: 'Retirée le', cellClassName: 'wrap-anywhere', cell: (r) => formatShortDate(r.removed_at) },
              { key: 'by', header: 'Par', cellClassName: 'wrap-anywhere', cell: (r) => r.removed_by_username ?? 'Équipe' },
            ]}
          />
        ) : <p className="card-frame p-6 text-center text-sm">Aucune carte retirée.</p>)
          : removalsFailed ? (
            <LoadError ref={retryRemovals} text="Les cartes retirées n'ont pas pu être chargées." onRetry={() => { focusRemoved.current = true; setRemovalsFailed(false); void readRemovals() }} />
          ) : <Loading label="Chargement des cartes retirées" />}
      </section>

      {picker && (
        <CatalogPicker
          title="Choisir une carte"
          onClose={() => setPicker(false)}
          onPick={async (pickedId) => {
            setPicker(false)
            router.push(`/admin/cards?card=${pickedId}`)
          }}
        />
      )}
      {d && c && (modal === 'hide' || modal === 'nsfw') && (
        <ActionModal
          title={modal === 'hide' ? (c.hide_image ? 'Afficher l\'image ?' : 'Masquer l\'image ?') : (c.nsfw_image ? 'Retirer « sensible » ?' : 'Marquer l\'image comme sensible ?')}
          consequence={flagsConsequence(c, { hide_image: modal === 'hide' ? !c.hide_image : c.hide_image, nsfw_image: modal === 'nsfw' ? !c.nsfw_image : c.nsfw_image })}
          action={modal === 'hide' ? (c.hide_image ? 'Afficher l\'image' : 'Masquer l\'image') : (c.nsfw_image ? 'Retirer « sensible »' : 'Marquer sensible')}
          tone={modal === 'hide' && !c.hide_image ? 'danger' : 'primary'}
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            const extra = { hide_image: modal === 'hide' ? !c.hide_image : c.hide_image, nsfw_image: modal === 'nsfw' ? !c.nsfw_image : c.nsfw_image }
            await post(`flags:${c.id}:${JSON.stringify(extra)}`, `${base}/flags`, 'POST', reason, extra)
            toast('Image mise à jour.')
            done()
          }}
        />
      )}
      {d && c && modal === 'remove' && (
        <ActionModal
          title="Retirer cette carte ?"
          consequence="La carte sort du catalogue et des tirages. Ses ventes actives sont annulées et les mises rendues, ses échanges en attente annulés, ses demandes de guilde, vitrines et avatars retirés, sa banque de quiz effacée. Les copies restent chez leurs propriétaires."
          action="Retirer la carte"
          tone="danger"
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            const res = await post<{ voided_auctions?: number; cancelled_trades?: number }>(`remove:${c.id}`, `${base}/removal`, 'POST', reason)
            toast(`Carte retirée : ${count(res.voided_auctions ?? 0, 'vente annulée', 'ventes annulées')}, ${count(res.cancelled_trades ?? 0, 'échange annulé', 'échanges annulés')}.`)
            done()
          }}
        >
          <ul className="space-y-1 text-sm">
            {ENGAGEMENTS.map(([k, one, many]) => <li key={k}>{count(d.engagements[k], one, many)}</li>)}
            <li>{count(d.image_reports, 'signalement d\'image', 'signalements d\'image')}</li>
          </ul>
        </ActionModal>
      )}
      {d && c && modal === 'restore' && (
        <ActionModal
          title="Remettre cette carte ?"
          consequence="La carte revient au catalogue. Les ventes et échanges annulés ne reviennent pas."
          action="Remettre la carte"
          tone="primary"
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            await post(`restore:${c.id}`, `${base}/removal`, 'DELETE', reason)
            toast('Carte remise.')
            done()
          }}
        />
      )}
      {d && c && modal === 'quiz' && (
        <ActionModal
          title="Effacer la banque de quiz ?"
          consequence="La banque sera recréée par modèles à la prochaine bataille, et par le générateur au prochain passage."
          action="Effacer la banque de quiz"
          tone="danger"
          onClose={() => setModal(null)}
          onConfirm={async (reason) => {
            await post(`quiz:${c.id}`, `${base}/quiz-clear`, 'POST', reason)
            toast('Banque de quiz effacée.')
            done()
          }}
        />
      )}
    </div>
  )
}
