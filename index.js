import {
  Telegraf
} from 'telegraf';
import request from 'request'
import pkg from 'simpl.db';
const {
  Database
} = pkg;
import dotenv from 'dotenv';
import strings from './strings.js';
dotenv.config();
import express from 'express'
const app = express();


if (process.env.TELEGRAM_KEY) {
  const bot = new Telegraf(process.env.TELEGRAM_KEY).catch(err => console.log(err))

  const db = new Database();

  const getId = (cookie, currUser) => new Promise((resolve, reject) => {
    request({
      'method': 'GET',
      'url': 'https://ais.usvisa-info.com/en-br/niv/account',
      'headers': {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
        'Cookie': `_yatri_session=${cookie}`
      },
      maxRedirects: 2
    }, function (error, response) {
      try {
        if (error) return reject(error);
        const dateIndex = response.body.indexOf('Consular Appointment')
        const [day, monthString, year] = response.body.slice(dateIndex + 48, dateIndex + 100).split(',').splice(0, 2).join('').split(' ')
        const month = {
          'January': '01',
          'February': '02',
          'March': '03',
          'April': '04',
          'May': '05',
          'June': '06',
          'July': '07',
          'August': '08',
          'September': '09',
          'October': '10',
          'November': '11',
          'December': '12'
        } [monthString]
        const currentDate = new Date(`${year}-${month}-${day}`)
        const newCookie = response.headers['set-cookie'][0].split(';')[0].split('=')[1]
        db.set(`users.${currUser}.cookie`, newCookie)
        db.set(`users.${currUser}.currentDate`, currentDate.toISOString())
        const index = response.body.indexOf('href="/en-br/niv/schedule/')
        const id = response.body.slice(index + 26, index + 50).split('/')[0]
        resolve(id)
      } catch (err) {
        reject(err)
      }
    });
  })

  const getLastDates = (cookie, id, chatId, limit = 5) => new Promise((resolve, reject) => {
    request({
      'method': 'GET',
      'url': `https://ais.usvisa-info.com/en-br/niv/schedule/${id}/appointment/days/128.json?appointments\\[expedite\\]=false`,
      'headers': {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
        'Cookie': `_yatri_session=${cookie}`
      }
    }, function (error, response) {
      try {
        if (error) return reject(error);
        const newCookie = response.headers['set-cookie'][0].split(';')[0].split('=')[1]
        db.set(`users.${chatId}.cookie`, newCookie)
        const dates = JSON.parse(response.body)
        if (dates.error) return reject(dates.error)
        resolve(dates.slice(0, limit))
      } catch (err) {
        reject(err)
      }
    });

  })

  const lookupChanges = () => {
    const users = db.get('users')
    const usersKeys = Object.keys(users)
    const nextUserCheck = db.get('nextUserCheck') || (usersKeys.length > 0 ? usersKeys[0] : false)
    if (nextUserCheck) {
      const currUser = users[nextUserCheck]
      console.log(`Checking ${nextUserCheck}`)
      if (currUser?.cookie) {
        getLastDates(currUser.cookie, currUser.id, nextUserCheck, 15)
          .then(async dates => {

            //Find date closer to the desiredDate or the lowest date

            let bestDateObj = dates[0]
            let notify = false

            if(currUser.desiredDate) {
              const desiredDate = new Date(currUser.desiredDate)

              bestDateObj = dates.reduce((best, date) => {
                const currDate = new Date(date.date)
                const bestDate = new Date(best.date)
                const diff = Math.abs(currDate - desiredDate)
                const bestDiff = Math.abs(bestDate - desiredDate)
                return bestDiff < diff ? best : date
              })
            }

            const bestDate = new Date(bestDateObj.date)
            const currDate = new Date(currUser.currentDate)


            if(currUser.desiredDate){
              //Check if bestDate is closer to the desiredDate than the currentDate

              const desiredDate = new Date(currUser.desiredDate)
              const diff = Math.abs(bestDate - desiredDate)
              const currDiff = Math.abs(currDate - desiredDate)
              if (diff < currDiff) {
                notify = true
              }
            }else{
              notify = bestDate <= currDate
            }

            if (notify && currUser.lastBestDate !== bestDateObj.date) {
              db.set(`users.${nextUserCheck}.lastBestDate`, bestDateObj.date)
              await bot.telegram.sendMessage(nextUserCheck, `Hey! I just found a date (${bestDateObj.date}) that fits you better than the current one (${currDate.toISOString().split('T')[0]}). \nThose are the ${dates.length} dates available:`)
              bot.telegram.sendMessage(nextUserCheck, dates.reduce((acc, curr) => {
                acc += `- ${new Date(curr.date).toLocaleDateString()}\n`
                return acc
              }, ''))
            }
          }).catch(err => {
            console.log(err)
            bot.telegram.sendMessage(nextUserCheck, `Your cookie is invalid. Please, send it again.`)
            db.delete(`users.${nextUserCheck}.cookie`)
          })
      } else {
        console.log('No cookie')
      }
      const nextUser = usersKeys.indexOf(nextUserCheck) + 1
      db.set('nextUserCheck', usersKeys[nextUser] || usersKeys[0])
    } else {
      console.log('No users to check')
    }
  }

  bot.start((ctx) => ctx.reply(strings.SEND_COOKIE))

  bot.on('text', async (ctx) => {
    //If the user sends a message bigger than 30 caracters, it's probably a cookie.
    if (ctx.update.message?.text.length > 30) {
      getId(ctx.update.message.text, ctx.update.message.chat.id)
        .then(id => {
          db.set(`users.${ctx.update.message.chat.id}.id`, id)
          return getLastDates(ctx.update.message.text, id, ctx.update.message.chat.id, 10)
        })
        .then(async dates => {
          if (dates.length > 0) {
            await ctx.reply('Thanks 😋')
            db.set(`users.${ctx.update.message.chat.id}.cookie`, ctx.update.message.text)
            await ctx.reply(`Connected successfully! You have ${dates.length} dates available.\n
Every time you wanna check which dates are available, just send me /check 🙃\n
If you want to set an specific date, you can send me /setdate with the date in the format dd/mm/yyyy.`)
            ctx.reply(`You can reschedule at https://ais.usvisa-info.com/en-br/niv/users/sign_in`)
            const desiredDate = new Date(db.get(`users.${ctx.update.message.chat.id}.desiredDate`))
            if(!isNaN(desiredDate.getTime())){
              await ctx.reply(`From now on if I find any date that is available closer to ${desiredDate.toISOString()} I will let you know 😉`)
            }else{
              await ctx.reply(`From now on if I find any date that is available sooner than ${new Date(db.get(`users.${ctx.update.message.chat.id}.currentDate`)).toLocaleDateString()} I will let you know 😉`)
            }
          } else {
            ctx.reply('Sorry, no dates available 😢')
          }
        }).catch(err => {
          ctx.reply(strings.BAD_COOKIE)
        })
    } else

    if (ctx.update.message.text === '/check') {
      await ctx.reply('Connecting...')
      const currUser = db.get(`users.${ctx.update.message.chat.id}`)
        getLastDates(currUser.cookie, currUser.id, ctx.update.message.chat.id, 10)
        .then(async dates => {
          if (dates.length > 0) {
            await ctx.reply(`You have ${dates.length} dates available:`)
            ctx.reply(dates.reduce((acc, curr) => {
              acc += `- ${new Date(curr.date).toLocaleDateString()}\n`
              return acc
            }, ''))
            ctx.reply('https://ais.usvisa-info.com/en-br/niv/users/sign_in')
          } else {
            ctx.reply('Sorry, no dates available 😢')
          }
        }).catch(err => {
          console.log(err)
          db.delete(`users.${ctx.update.message.chat.id}.cookie`)
          ctx.reply(strings.BAD_COOKIE)
        })
    } else

    if (ctx.update.message.text.indexOf('/setdate') === 0) {
      const [day, month, year] = ctx.update.message.text.split(' ')[1].split('/').map(el => Number(el))
      const desiredDate = new Date(`${year}-${month}-${day}`)
      if (!isNaN(desiredDate.getTime())) {
        db.set(`users.${ctx.update.message.chat.id}.desiredDate`, desiredDate.toISOString())
        await ctx.reply(`Nice! I will check for dates that are available closer to ${desiredDate.toLocaleDateString()}\nIf you wanna get back to finding the lowest date, just send me /lowestdate`)
      } else {
        await ctx.reply('Please, send me the date in the format dd/mm/yyyy')
      }
    } else

    if (ctx.update.message.text.indexOf('/lowestdate') === 0) {
      db.delete(`users.${ctx.update.message.chat.id}.desiredDate`)
      await ctx.reply(`Now i'm looking for the lowest date available`)
    } else

    if (ctx.update.message.text.indexOf('/status') === 0) {
      const currUser = db.get(`users.${ctx.update.message.chat.id}`)
      ctx.reply('Checking...')
      getId(currUser.cookie, ctx.update.message.chat.id).then(id => {
        ctx.reply(`
Status: Connected!
Current date scheduled: ${new Date(db.get(`users.${ctx.update.message.chat.id}.currentDate`)).toISOString().split('T')[0]}
Desired date: ${db.get(`users.${ctx.update.message.chat.id}.desiredDate`) ? new Date(db.get(`users.${ctx.update.message.chat.id}.desiredDate`)).toISOString().split('T')[0] : 'Not set'}
`)
      }).catch(err => {
        console.log(err)
        ctx.reply(strings.BAD_COOKIE)
      })
    }

    if(ctx.update.message.text.indexOf('/help') === 0){
      ctx.reply(strings.HELP)
    }

  })

  bot.launch().then(() => {
    console.log('Bot Started.')
  })

  setInterval(lookupChanges, 1000 * 60 * (process.env.REFRESH_INTERVAL || 1)) // 1 minute
} else {
  console.log('Please define a valid telegram key in .env file.')
}

app.get('/', (req, res) => {
  const name = process.env.NAME || 'World';
  res.send(`Hello ${name}!`);
});

const port = parseInt(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});