package demo

trait Greeter {
  def greet(name: String): String
}

class Formal extends Greeter {
  def greet(name: String): String = "Good day, " + name
}

class Casual extends Greeter {
  def greet(name: String): String = "hey " + name
}
