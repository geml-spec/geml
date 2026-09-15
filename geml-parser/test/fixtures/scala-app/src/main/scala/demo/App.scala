package demo

object App {
  def pick(formal: Boolean): Greeter = if (formal) new Formal else new Casual

  def run(name: String): String = {
    val g = pick(true)
    val c = Counter().inc()
    Util.shout(g.greet(name)) + c.value
  }

  def main(args: Array[String]): Unit = println(run("geml"))
}
