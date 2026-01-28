import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  try {
    const totalUsers = await prisma.user.count()
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: 'desc'
      }
    })

    // Group users by date
    const signupsByDate: Record<string, number> = {}
    users.forEach(user => {
      const date = user.createdAt.toISOString().split('T')[0]
      signupsByDate[date] = (signupsByDate[date] || 0) + 1
    })

    return NextResponse.json({
      total: totalUsers,
      signupsByDate,
      recentUsers: users.slice(0, 10).map(user => ({
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      }))
    })
  } catch (error) {
    console.error('Error fetching signups:', error)
    return NextResponse.json(
      { error: 'Failed to fetch signups' },
      { status: 500 }
    )
  }
}
