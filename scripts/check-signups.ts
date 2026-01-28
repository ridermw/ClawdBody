import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function checkSignups() {
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

    console.log('\n📊 Signup Statistics\n')
    console.log(`Total Signups: ${totalUsers}`)
    console.log('\nRecent Signups:')
    console.log('─'.repeat(80))
    
    users.forEach((user, index) => {
      console.log(`${index + 1}. ${user.email || 'No email'} | ${user.name || 'No name'}`)
      console.log(`   Created: ${user.createdAt.toLocaleString()}`)
      console.log('─'.repeat(80))
    })

  } catch (error) {
    console.error('Error fetching signups:', error)
  } finally {
    await prisma.$disconnect()
  }
}

checkSignups()
