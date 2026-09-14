"""Generate DramaCraft's synthetic Chinese voice samples with edge-tts."""

import asyncio
from pathlib import Path

import edge_tts


OUTPUT = Path(__file__).resolve().parents[1] / "resources" / "voices"
SAMPLES = [
    ("女声_儿童_天真灵动.mp3", "zh-CN-XiaoyiNeural", "+18%", "+35Hz", "快看，纸船真的穿过石桥啦！我们沿着河边跑，也许还能追上它。"),
    ("女声_少年_活泼明亮.mp3", "zh-CN-XiaoyiNeural", "+12%", "+20Hz", "别担心，我已经记住回去的路。等雨停了，我们一起翻过前面的山坡。"),
    ("女声_青年_清冷轻熟.mp3", "zh-CN-XiaoxiaoNeural", "-8%", "+0Hz", "窗外的雪已经停了。你若现在出发，天亮之前还能赶到北城门。"),
    ("女声_青年_英气飒爽.mp3", "zh-CN-XiaobeiNeural", "+10%", "+8Hz", "都跟紧我，穿过这条巷子就是码头。今天无论如何，我们都要把人带回来。"),
    ("女声_青年_温柔治愈.mp3", "zh-CN-XiaoxiaoNeural", "-12%", "+10Hz", "慢一点也没关系。灯一直亮着，等你整理好心情，我们再继续往前走。"),
    ("女声_青年_俏皮机敏.mp3", "zh-CN-XiaoyiNeural", "+18%", "+12Hz", "这点小把戏可瞒不过我。你先守住门口，剩下的就交给我来处理吧。"),
    ("女声_中年_粗粝朴实.mp3", "zh-CN-liaoning-XiaobeiNeural", "-12%", "-18Hz", "庄稼人不讲漂亮话，答应你的事就一定办到。先喝口热水，再慢慢说。"),
    ("女声_中年_冷艳威严.mp3", "zh-CN-XiaoxiaoNeural", "-18%", "-12Hz", "规矩既然定下，就没人能够例外。把账册留下，其他人现在可以出去了。"),
    ("女声_中年_爽朗直率.mp3", "zh-CN-shaanxi-XiaoniNeural", "+5%", "-5Hz", "有话就直说，别在门口磨磨蹭蹭。饭已经热好了，大家坐下来聊。"),
    ("女声_老年_慈祥从容.mp3", "zh-CN-XiaoxiaoNeural", "-25%", "-22Hz", "许多事情急不得，像院里的老树一样，总要经过几场风雨，才懂得扎根。"),
    ("男声_儿童_机灵活泼.mp3", "zh-CN-YunxiaNeural", "+20%", "+28Hz", "我知道钥匙藏在哪里，不过你得先答应我，找到宝箱以后让我第一个看。"),
    ("男声_儿童_顽皮搞怪.mp3", "zh-CN-YunxiaNeural", "+28%", "+38Hz", "糟糕，木桶怎么自己滚下去了？这可不是我推的，真的不是，快跑呀！"),
    ("男声_少年_张扬热血.mp3", "zh-CN-YunxiNeural", "+18%", "+15Hz", "只要终点还在前面，我就不会停下。下一回合，让他们看看我们的本事！"),
    ("男声_青年_清亮温润.mp3", "zh-CN-YunxiNeural", "-5%", "+6Hz", "山路虽然远，沿途的风景却很好。你若愿意，我可以陪你慢慢走完这一程。"),
    ("男声_青年_孤傲沉稳.mp3", "zh-CN-YunyangNeural", "-18%", "-8Hz", "胜负从来不靠运气。既然选择站在这里，就要承担选择带来的结果。"),
    ("男声_青年_清亮通透.mp3", "zh-CN-YunxiNeural", "+5%", "+12Hz", "晨雾散开以后，远处的塔就能看见。我们顺着钟声走，不会迷路。"),
    ("男声_青年_清朗洒脱.mp3", "zh-CN-YunxiNeural", "+12%", "+8Hz", "江湖这么大，总有再见的时候。今天先痛快喝一杯，明天各走各的路。"),
    ("男声_青年_市井油滑.mp3", "zh-CN-YunxiNeural", "+15%", "-6Hz", "客官真是好眼力，这东西全城只剩一件。价钱嘛，咱们当然可以慢慢商量。"),
    ("男声_青年_年轻利落.mp3", "zh-CN-YunjianNeural", "+20%", "+5Hz", "路线确认，装备齐全，三分钟后出发。到达路口以后，按原计划分头行动。"),
    ("男声_中年_阴沉霸烈.mp3", "zh-CN-YunyangNeural", "-20%", "-18Hz", "我给过你离开的机会。既然还敢回来，就别指望这扇门会再打开。"),
    ("男声_中年_热情豪迈.mp3", "zh-CN-YunjianNeural", "+8%", "-5Hz", "来得正好，炉上的酒刚刚温热。坐下喝一碗，今晚我们不醉不归！"),
    ("男声_中年_世故痞气.mp3", "zh-CN-YunxiNeural", "-5%", "-12Hz", "这条街上的规矩，我比谁都清楚。想把事情办成，光有胆量可还不够。"),
    ("男声_中年_尖细阴柔.mp3", "zh-CN-YunxiaNeural", "-15%", "+18Hz", "话可不能说得太满。棋局还没有结束，谁输谁赢，现在下结论太早。"),
    ("男声_中年_豪爽硬朗.mp3", "zh-CN-YunjianNeural", "+2%", "-10Hz", "兄弟们辛苦了，剩下这段路由我带头。翻过山口，我们就能平安回家。"),
    ("男声_老年_沙哑沧桑.mp3", "zh-CN-YunyangNeural", "-28%", "-25Hz", "这座城我守了四十年，每块砖都认得我的脚步。只是故人，再也不会回来了。"),
]


async def generate(sample):
    filename, voice, rate, pitch, text = sample
    await edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(
        str(OUTPUT / filename)
    )


async def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    semaphore = asyncio.Semaphore(4)

    async def limited(sample):
        async with semaphore:
            await generate(sample)

    await asyncio.gather(*(limited(sample) for sample in SAMPLES))


if __name__ == "__main__":
    asyncio.run(main())
