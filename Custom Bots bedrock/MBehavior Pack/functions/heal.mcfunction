playsound custom_sound.gaps @a ~~~
replaceitem entity @s slot.weapon.mainhand 0 minecraft:enchanted_golden_apple 1
particle bot:eat_golden_apple ~ ~1.5 ~
# Enchanted golden apple (Notch apple) effects: absorption,
# regeneration, resistance, and fire resistance rather than a normal golden apple.
effect @s absorption 120 3 true
effect @s regeneration 20 1 true
effect @s resistance 300 0 true
effect @s fire_resistance 300 0 true
