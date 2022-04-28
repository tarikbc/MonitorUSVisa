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
        db.set(`users.${currUser}.currentDate`, currentDate.toISOString())
        const index = response.body.indexOf('href="/en-br/niv/schedule/')
        const id = response.body.slice(index + 26, index + 50).split('/')[0]
        resolve(id)
      } catch (err) {
        reject(err)
      }
    });
  })

  const getLastDates = (cookie, id, limit = 5) => new Promise((resolve, reject) => {
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
        const dates = JSON.parse(response.body)
        if (dates.error) return reject(dates.error)
        resolve(dates.slice(0, limit))
      } catch (err) {
        reject(err)
      }
    });

  })

  bot.start((ctx) => ctx.reply(strings.SEND_COOKIE))

  bot.on('text', async (ctx) => {
    //If the user sends a message bigger than 30 caracters, it's probably a cookie.
    if (ctx.update.message?.text.length > 30) {
      getId(ctx.update.message.text, ctx.update.message.chat.id)
        .then(id => {
          db.set(`users.${ctx.update.message.chat.id}.id`, id)
          return getLastDates(ctx.update.message.text, id, 10)
        })
        .then(async dates => {
          if (dates.length > 0) {
            await ctx.reply('Thanks 😋')
            db.set(`users.${ctx.update.message.chat.id}.cookie`, ctx.update.message.text)
            db.set(`users.${ctx.update.message.chat.id}.dates`, dates)
            await ctx.reply(`Connected successfully! You have ${dates.length} dates available.`)
            ctx.reply(`You can reschedule at https://ais.usvisa-info.com/en-br/niv/users/sign_in`)
            await ctx.reply(`From now on if I find any date that is available sooner than ${new Date(db.get(`users.${ctx.update.message.chat.id}.currentDate`)).toLocaleDateString()} I will let you know 😉`)
          } else {
            ctx.reply('Sorry, no dates available 😢')
          }
        }).catch(err => {
          ctx.reply(strings.BAD_COOKIE)
        })
    }

    if (ctx.update.message.text === '/check') {
      await ctx.reply('Connecting...')
      const currUser = db.get(`users.${ctx.update.message.chat.id}`)
        .then(getLastDates(currUser.cookie, currUser.id, 10))
        .then(async dates => {
          if (dates.length > 0) {
            db.set(`users.${ctx.update.message.chat.id}.dates`, dates)
            await ctx.reply(`You have ${dates.length} dates available:`)
            ctx.reply(dates.reduce((acc, curr) => {
              acc += `${new Date(curr.date).toLocaleDateString()} - ${curr.time}\n`
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
    }

  })

  bot.launch().then(() => {
    console.log('Bot Started.')
  })


  const lookupChanges = () => {
    const users = db.get('users')
    const usersKeys = Object.keys(users)
    const nextUserCheck = db.get('nextUserCheck') || (usersKeys.length > 0 ? usersKeys[0] : false)
    if (nextUserCheck) {
      const currUser = users[nextUserCheck]
      console.log(`Checking ${nextUserCheck}`)
      if (currUser?.cookie) {
          getLastDates(currUser.cookie, currUser.id)
          .then(async dates => {
            const dateEl = dates[0].date.split('-')
            const lowerDate = new Date(dateEl[0], dateEl[1] - 1, dateEl[2])
            if (lowerDate.getTime() < new Date(currUser.currentDate).getTime()) {
              await bot.telegram.sendMessage(nextUserCheck, `You have ${dates.length} dates available:`)
              bot.telegram.sendMessage(dates.reduce((acc, curr) => {
                acc += `${new Date(curr.date).toLocaleDateString()} - ${curr.time}\n`
                return acc
              }, ''))
              db.set(`users.${nextUserCheck}.dates`, dates)
            }
          }).catch(err => {
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