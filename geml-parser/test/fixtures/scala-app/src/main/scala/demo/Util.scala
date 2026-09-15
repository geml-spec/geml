package demo

object Util {
  def shout(s: String): String = s.toUpperCase + "!"
  def shout(n: Int): String = shout(n.toString)
}
