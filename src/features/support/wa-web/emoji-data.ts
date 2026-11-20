/**
 * Emoji for the WhatsApp composer, by category, with search names. Native emoji (rendered by the operating system's
 * font, as WhatsApp Web does on most systems): no image downloads and no third-party package.
 * Each entry is "emoji name words".
 */
export interface EmojiCategory { key: string; label: string; icon: string; items: [emoji: string, name: string][] }

const parse = (s: string): [string, string][] => s.trim().split('\n').map((l) => {
  const t = l.trim()
  const i = t.indexOf(' ')
  return [t.slice(0, i), t.slice(i + 1)]
})

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  { key: 'smileys', label: 'Smileys & people', icon: '😀', items: parse(`
😀 grinning face smile happy
😃 smiling face big eyes happy
😄 smiling face smiling eyes laugh
😁 beaming face grin
😆 grinning squinting laugh
😅 sweat smile relief
🤣 rolling on the floor laughing rofl
😂 tears of joy laugh lol
🙂 slightly smiling face
🙃 upside down face
😉 winking face wink
😊 smiling face blush
😇 halo angel innocent
🥰 smiling face hearts love
😍 heart eyes love
🤩 star struck excited
😘 face blowing a kiss
😗 kissing face
😋 yummy savouring food
😛 tongue out
😜 winking tongue
🤪 zany crazy
😝 squinting tongue
🤑 money mouth
🤗 hugging hug
🤭 hand over mouth oops
🤫 shushing quiet
🤔 thinking hmm
🤐 zipper mouth secret
🤨 raised eyebrow doubt
😐 neutral face
😑 expressionless
😶 no mouth speechless
😏 smirking
😒 unamused
🙄 rolling eyes
😬 grimacing awkward
😌 relieved
😔 pensive sad
😪 sleepy
🤤 drooling
😴 sleeping zzz
😷 medical mask sick
🤒 thermometer ill fever
🤕 head bandage hurt
🤢 nauseated
🤧 sneezing cold
🥵 hot face
🥶 cold face freezing
😵 dizzy
🤯 exploding head shocked mind blown
🤠 cowboy
🥳 partying celebration
😎 sunglasses cool
🤓 nerd
🧐 monocle
😕 confused
😟 worried
🙁 slightly frowning
😮 open mouth surprised
😯 hushed
😲 astonished
😳 flushed embarrassed
🥺 pleading puppy eyes please
😦 frowning open mouth
😧 anguished
😨 fearful scared
😰 anxious sweat
😥 sad but relieved
😢 crying tear sad
😭 loudly crying sob
😱 screaming fear
😖 confounded
😣 persevering
😞 disappointed
😓 downcast sweat
😩 weary
😫 tired
🥱 yawning
😤 steam from nose triumph
😡 pouting angry
😠 angry
🤬 cursing swearing
👍 thumbs up like ok yes
👎 thumbs down dislike no
👌 ok hand perfect
✌️ victory peace
🤞 crossed fingers luck hope
🤝 handshake deal agreement
🙏 folded hands please thanks pray namaste
👏 clapping applause
🙌 raising hands celebrate
👋 waving hand hello bye
✋ raised hand stop
🤚 raised back of hand
👊 fist bump
✊ raised fist
💪 flexed biceps strong
👀 eyes look
🫡 saluting face
🙋 person raising hand
🤷 person shrugging dunno
🤦 face palm
💁 person tipping hand info
🙇 person bowing sorry
👨‍💼 office worker man
👩‍💼 office worker woman
👷 construction worker
🧑‍🔧 mechanic
`) },
  { key: 'animals', label: 'Animals & nature', icon: '🐻', items: parse(`
🐶 dog puppy
🐱 cat
🐭 mouse
🐰 rabbit
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger
🦁 lion
🐮 cow
🐷 pig
🐸 frog
🐵 monkey
🐔 chicken
🐧 penguin
🐦 bird
🦆 duck
🦉 owl
🐴 horse
🦋 butterfly
🐝 bee
🐞 ladybird
🐢 turtle
🐍 snake
🐘 elephant
🐪 camel
🐟 fish
🐬 dolphin
🐳 whale
🌸 cherry blossom flower
🌹 rose flower
🌻 sunflower
🌼 blossom
🌷 tulip
🌱 seedling plant
🌿 herb
🍀 four leaf clover luck
🌳 tree
🌴 palm tree
🌵 cactus
🍁 maple leaf
🌍 globe earth world
🌙 moon night
⭐ star
🌟 glowing star
☀️ sun sunny
⛅ cloud sun
🌧️ rain
⛈️ thunderstorm
❄️ snowflake cold
🌈 rainbow
🔥 fire hot lit
💧 droplet water
🌊 wave sea
`) },
  { key: 'food', label: 'Food & drink', icon: '🍔', items: parse(`
🍏 green apple
🍎 red apple
🍊 orange
🍋 lemon
🍌 banana
🍉 watermelon
🍇 grapes
🍓 strawberry
🥭 mango
🍍 pineapple
🥥 coconut
🥝 kiwi
🍅 tomato
🥕 carrot
🌽 corn
🌶️ chilli pepper hot
🥔 potato
🧅 onion
🧄 garlic
🍞 bread
🧀 cheese
🍳 cooking egg
🍔 burger
🍟 fries
🍕 pizza
🌮 taco
🥪 sandwich
🍛 curry rice
🍚 rice
🍜 noodles
🍲 pot of food
🥗 salad
🍿 popcorn
🍩 doughnut
🍪 cookie
🎂 birthday cake
🍰 cake
🧁 cupcake
🍫 chocolate
🍬 sweet candy
🍯 honey
☕ coffee hot tea
🍵 tea
🥛 milk
🧃 juice
🥤 soft drink
🍺 beer
🍷 wine
🥂 cheers toast
🍽️ plate cutlery dinner
`) },
  { key: 'activities', label: 'Activities', icon: '⚽', items: parse(`
⚽ football soccer
🏏 cricket
🏀 basketball
🏐 volleyball
🎾 tennis
🏸 badminton
🏓 table tennis
⛳ golf
🏆 trophy winner
🥇 gold medal first
🥈 silver medal
🥉 bronze medal
🏅 medal
🎖️ military medal
🎯 bullseye target goal
🎮 video game
🎲 dice game
🧩 puzzle
🎨 art palette
🎭 theatre
🎤 microphone sing
🎧 headphones music
🎸 guitar
🎹 piano
🥁 drum
🎉 party popper celebrate congrats
🎊 confetti
🎈 balloon
🎁 gift present
🎀 ribbon
🪔 diya lamp diwali
🎆 fireworks
🎇 sparkler
🧘 yoga
🏃 running
🚴 cycling
🏋️ weight lifting
`) },
  { key: 'travel', label: 'Travel & places', icon: '🚗', items: parse(`
🚗 car
🚕 taxi
🚌 bus
🚑 ambulance
🚒 fire engine
🚓 police car
🚚 delivery truck lorry
🚛 articulated lorry truck
🚜 tractor
🛵 scooter
🏍️ motorcycle
🚲 bicycle
🛺 auto rickshaw
🚆 train
🚇 metro
✈️ aeroplane flight
🚀 rocket launch
🚢 ship
⚓ anchor
⛽ fuel pump petrol
🚧 construction
🚦 traffic light
🗺️ map
📍 round pushpin location
🏠 house home
🏢 office building
🏭 factory
🏬 department store
🏪 shop store
🏦 bank
🏥 hospital
🏫 school
🏨 hotel
🕌 mosque
🛕 hindu temple
⛪ church
🗽 statue
🏖️ beach
⛰️ mountain
🌆 city
`) },
  { key: 'objects', label: 'Objects', icon: '💡', items: parse(`
📱 mobile phone
💻 laptop
🖥️ desktop computer
⌨️ keyboard
🖨️ printer
📷 camera
📹 video camera
📞 telephone receiver call
☎️ telephone
📠 fax
🔋 battery
🔌 plug
💡 light bulb idea
🔦 torch
🧰 toolbox
🔧 spanner wrench
🔨 hammer
🪛 screwdriver
⚙️ gear settings
🧱 brick
🪵 wood
🚿 shower
🛁 bathtub
🚽 toilet
🚰 tap water
🪣 bucket
🧴 lotion bottle
🧼 soap
📦 package box parcel
📫 mailbox
✉️ envelope letter
📧 email
📄 page document
📃 page curl
📑 bookmark tabs
📊 bar chart
📈 chart increasing
📉 chart decreasing
🗓️ calendar
📅 date
📌 pushpin
📎 paperclip attachment
✂️ scissors
🖊️ pen
✏️ pencil
📝 memo note
🔒 locked
🔓 unlocked
🔑 key
💰 money bag
💳 credit card
🧾 receipt invoice
💸 money with wings
⏰ alarm clock
⌛ hourglass
⏱️ stopwatch
🛒 shopping cart
`) },
  { key: 'symbols', label: 'Symbols', icon: '❤️', items: parse(`
❤️ red heart love
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🖤 black heart
🤍 white heart
💔 broken heart
💕 two hearts
💯 hundred points
✅ check mark done
☑️ ballot box with check
✔️ check mark
❌ cross mark no
❎ cross mark button
➕ plus
➖ minus
❗ exclamation
❓ question
⚠️ warning
🚫 prohibited
⛔ no entry
🔴 red circle
🟠 orange circle
🟡 yellow circle
🟢 green circle
🔵 blue circle
⚪ white circle
⚫ black circle
⬆️ up arrow
⬇️ down arrow
➡️ right arrow
⬅️ left arrow
🔄 counterclockwise arrows refresh
🔁 repeat
▶️ play
⏸️ pause
⏹️ stop
🆕 new
🆗 ok button
🆓 free
🔝 top
🔜 soon
ℹ️ information
🔔 bell notification
🔕 bell with slash mute
💬 speech balloon chat
💭 thought balloon
🕐 one o clock
✳️ eight spoked asterisk
#️⃣ hash keycap
`) },
]

export function searchEmoji(term: string, limit = 64): [string, string][] {
  const t = term.trim().toLowerCase()
  if (!t) return []
  const out: [string, string][] = []
  for (const c of EMOJI_CATEGORIES) for (const e of c.items) if (e[1].includes(t) && out.length < limit) out.push(e)
  return out
}
