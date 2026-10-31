import { adminTitle } from '@/lib/staff'
import { DashboardClient } from './dashboard-client'

export const generateMetadata = adminTitle('Administration')

export default function AdminPage() {
  return <DashboardClient />
}
