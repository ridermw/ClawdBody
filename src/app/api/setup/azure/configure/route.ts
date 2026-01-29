import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)

    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { region, vmSize } = await request.json()

    // Update setup state with Azure configuration
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.setupState.update({
      where: { userId: session.user.id },
      data: {
        azureRegion: region || 'eastus',
        azureVmSize: vmSize || 'Standard_B2s',
      } as any,
    })

    return NextResponse.json({
      success: true,
      message: 'Azure configuration saved',
    })

  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save Azure configuration' },
      { status: 500 }
    )
  }
}
