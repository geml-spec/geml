package demo

class Counter(start: Int) {
  private var n = start
  def inc(): Counter = { n += 1; this }
  def value: Int = n
}

object Counter {
  def apply(): Counter = new Counter(0)
}
