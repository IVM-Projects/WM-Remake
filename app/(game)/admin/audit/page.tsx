import { adminTitle } from '@/lib/staff'
import { AuditClient } from './audit-client'

export const generateMetadata = adminTitle('Journal des actions')

export default function AuditPage() {
  return <AuditClient />
}
